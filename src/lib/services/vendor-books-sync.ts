import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { Prisma, type VendorBooksSync } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveCompanyForCreate } from "@/lib/company";
import { isManualEntryOnly } from "@/lib/application-mode";
import { HttpError } from "@/lib/http";
import { vendorSchema } from "@/lib/validation";
import { canManageVendors } from "@/lib/permissions";
import { createVendor } from "./catalog";
import { assertWrite, booksConfigurationHash, getConfig, IntegrationError, type ZohoConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { accessToken } from "@/lib/integrations/oauth";
import { ZohoTransport } from "@/lib/integrations/transport";
import { assertVendorSyncSource, vendorContactCapability, vendorSourceFields, vendorSnapshotHash,
  vendorSyncSnapshotSchema, type VendorContactWriteCapability, type VendorSyncSnapshot } from "@/lib/integrations/vendor-write";

type Store = Prisma.TransactionClient;
type VendorSource = Prisma.VendorGetPayload<{select: typeof vendorSourceFields}>;
type Destination = {organizationId:string;dataCenter:string;environment:string};
type Plan = {companyId:string;config:ZohoConfig|null;destination:Destination|null;message:string|null;local:boolean};
export type VendorSyncSummary = {status:string;message:string;organizationId?:string;externalVendorId?:string;vendorId:string};
export type VendorTransportFactory = (config:ZohoConfig, capability?:VendorContactWriteCapability)=>ZohoTransport;
const transportFor:VendorTransportFactory = (config, capability) => new ZohoTransport(config,()=>accessToken(config),fetch,undefined,undefined,capability);
const fold = (value:string) => value.normalize("NFKC").trim().toLocaleLowerCase("en");
const block = (code:string,message:string) => new IntegrationError(code,message,"BLOCKED");
const messages:Record<string,string> = {
  QUEUED:"Supplier saved. Zoho Books synchronization is queued.",PROCESSING:"Supplier synchronization is in progress.",
  UNKNOWN:"The Zoho result needs verification. Check the result before attempting another creation.",
  BLOCKED:"Supplier saved locally. Its Books connection or supplier details need attention.",
  FAILED:"Supplier saved locally. Books did not accept the supplier; review its details before retrying.",
  SYNCED:"Supplier confirmed in Zoho Books.",LOCAL_ONLY:"Supplier saved in this workspace; this company has no active Books destination.",
};
const summary=(vendorId:string,job?:Pick<VendorBooksSync,"status"|"lastError"|"organizationId"|"externalVendorId">|null,
  fallback="LOCAL_ONLY",message?:string):VendorSyncSummary=>({vendorId,status:job?.status??fallback,
    message:message??job?.lastError??messages[job?.status??fallback],...(job?{organizationId:job.organizationId}:{}),
    ...(job?.externalVendorId?{externalVendorId:job.externalVendorId}:{})});

async function managementActor(actor:Pick<Actor,"id"|"role">,companyId:string,store:Store=db) {
  if (!["ADMIN","ACCOUNTS"].includes(actor.role) || !await store.user.findFirst({where:{id:actor.id,active:true,
    role:{in:["ADMIN","ACCOUNTS"]},memberships:{some:{companyId,active:true,company:{active:true}}}},select:{id:true}}))
    throw new HttpError(403,"Current supplier-management access to this company is required.");
}
async function plan(actor:Actor,companyId:string):Promise<Plan> {
  await managementActor(actor,companyId);
  if(isManualEntryOnly())return{companyId,config:null,destination:null,message:null,local:true};
  const destinations=await db.companyIntegrationDestination.findMany({where:{companyId,target:"ZOHO"},
    select:{organizationId:true,dataCenter:true,environment:true}});
  if(!destinations.length)return{companyId,config:null,destination:null,message:null,local:true};
  if(destinations.length!==1)return{companyId,config:null,destination:null,local:false,message:"Ask an administrator to select one exact Books destination for this supplier."};
  const destination=destinations[0];
  try {
    const config=getConfig("ZOHO",process.env,destination.organizationId);
    if(config.dataCenter!==destination.dataCenter||config.environment!==destination.environment)throw new Error("destination");
    return{companyId,config,destination,message:null,local:false};
  }catch{return{companyId,config:null,destination,local:false,message:"The company's Books connection is unavailable. The supplier remains saved locally."};}
}
function sourceOf(vendor:VendorSource):VendorSource {
  return{id:vendor.id,companyId:vendor.companyId,name:vendor.name,currency:vendor.currency,email:vendor.email,trn:vendor.trn,isDemo:vendor.isDemo,externalZohoId:vendor.externalZohoId};
}
function snapshotFor(vendor:VendorSource,config:ZohoConfig):VendorSyncSnapshot {
  const currency=config.booksMapping?.currencies[vendor.currency]?.id;
  if(!currency)throw block("VENDOR_CURRENCY_UNMAPPED","This supplier's currency needs a verified Books currency mapping.");
  const marker="VX-VENDOR-"+createHash("sha256").update(vendor.companyId+":"+vendor.id).digest("hex").slice(0,40);
  return vendorSyncSnapshotSchema.parse({vendor:sourceOf(vendor),destination:{organizationId:config.organizationId,
    dataCenter:config.dataCenter,environment:config.environment,connectionFingerprint:connectionFingerprint(config),configurationHash:booksConfigurationHash(config)},
    marker,payload:{contact_name:vendor.name,contact_type:"vendor",currency_id:currency,is_portal_enabled:false,
      tax_treatment:vendor.trn?"vat_registered":"vat_not_registered",...(vendor.trn?{tax_reg_no:vendor.trn}:{}),
      ...(vendor.email?{contact_persons:[{email:vendor.email,is_primary_contact:true}]}:{}),
      notes:"Created from bills.voltronix.ae. Reference: "+marker}});
}
async function enqueue(store:Store,actor:Actor,vendor:VendorSource,config:ZohoConfig) {
  await managementActor(actor,vendor.companyId,store);
  const snapshot=snapshotFor(vendor,config);
  const identity={vendorId:vendor.id,organizationId:config.organizationId,dataCenter:config.dataCenter,environment:config.environment};
  const existing=await store.vendorBooksSync.findUnique({where:{vendorId_organizationId_dataCenter_environment:identity}});
  if(existing&&!existing.submittedAt&&!existing.externalVendorId&&["QUEUED","BLOCKED","FAILED"].includes(existing.status)&&
    (!existing.leaseUntil||existing.leaseUntil<=new Date())&&existing.sourceHash!==vendorSnapshotHash(snapshot)) {
    await store.vendorBooksSync.updateMany({where:{id:existing.id,submittedAt:null,externalVendorId:null,sourceHash:existing.sourceHash,
      OR:[{leaseUntil:null},{leaseUntil:{lte:new Date()}}]},data:{snapshot:snapshot as Prisma.InputJsonValue,sourceHash:vendorSnapshotHash(snapshot),
      status:"QUEUED",initiatedById:actor.id,errorCode:null,lastError:null,nextAttemptAt:new Date()}});
    await store.auditLog.create({data:{actorId:actor.id,companyId:vendor.companyId,action:"VENDOR_SYNC_SOURCE_REFRESHED",entityType:"Vendor",entityId:vendor.id,
      details:{organizationId:config.organizationId,dataCenter:config.dataCenter,environment:config.environment,priorSubmission:false}}});
  }
  return store.vendorBooksSync.upsert({where:{vendorId_organizationId_dataCenter_environment:identity},update:{},
    create:{vendorId:vendor.id,companyId:vendor.companyId,organizationId:config.organizationId,dataCenter:config.dataCenter,
      environment:config.environment,initiatedById:actor.id,sourceHash:vendorSnapshotHash(snapshot),snapshot:snapshot as Prisma.InputJsonValue}});
}

/** Atomic local supplier plus durable intent; no provider request occurs in the DB transaction. */
export async function createVendorAndSync(actor:Actor,payload:unknown,factory:VendorTransportFactory=transportFor) {
  if(!canManageVendors(actor))throw new HttpError(403,"Only Admin and Accounts may manage vendors.");
  const input=vendorSchema.parse(payload);
  const companyId=await resolveCompanyForCreate(actor,input.companyId);
  const selected=await plan(actor,companyId);
  let queued=false;
  let setupMessage=selected.message;
  const vendor=await createVendor(actor,{...input,companyId},async(tx,created)=>{
    if(!selected.config)return;
    try {await enqueue(tx,actor,sourceOf(created),selected.config);queued=true;}
    catch(error){if(error instanceof IntegrationError){setupMessage=error.message;return;}throw error;}
  });
  const sync=queued?await synchronizeVendor(actor,vendor.id,factory)
    :summary(vendor.id,null,selected.local?"LOCAL_ONLY":"BLOCKED",setupMessage??undefined);
  return{vendor,sync};
}
export async function getVendorSync(actor:Actor,vendorId:string) {
  const vendor=await db.vendor.findUnique({where:{id:vendorId},select:vendorSourceFields});
  if(!vendor)throw new HttpError(404,"Supplier not found.");
  const selected=await plan(actor,vendor.companyId);
  if(!selected.config)return summary(vendor.id,null,selected.local?"LOCAL_ONLY":"BLOCKED",selected.message??undefined);
  const job=await db.vendorBooksSync.findUnique({where:{vendorId_organizationId_dataCenter_environment:{vendorId,
    organizationId:selected.config.organizationId,dataCenter:selected.config.dataCenter,environment:selected.config.environment}}});
  const mapped=await db.vendorBooksMapping.findUnique({where:{vendorId_organizationId_dataCenter_environment:{vendorId,
    organizationId:selected.config.organizationId,dataCenter:selected.config.dataCenter,environment:selected.config.environment}}});
  if(mapped)return vendor.externalZohoId&&vendor.externalZohoId!==mapped.externalVendorId
    ?summary(vendorId,null,"BLOCKED","The legacy supplier ID conflicts with its verified Books mapping. Administrator review is required.")
    :summary(vendorId,{status:"SYNCED",lastError:null,organizationId:mapped.organizationId,externalVendorId:mapped.externalVendorId});
  return summary(vendorId,job,"QUEUED",job?undefined:"This supplier needs Books synchronization.");
}

const remoteContact=z.object({contact_id:z.string().regex(/^\d{1,30}$/),contact_name:z.string(),contact_type:z.literal("vendor"),
  currency_code:z.string(),status:z.string().trim().toLowerCase(),email:z.unknown().optional(),tax_reg_no:z.unknown().optional(),notes:z.unknown().optional(),
  tax_treatment:z.string().optional(),contact_persons:z.array(z.object({email:z.unknown().optional()})).optional()});
type RemoteContact=z.infer<typeof remoteContact>;
async function readContact(transport:ZohoTransport,id:string) {
  const value=z.object({code:z.literal(0),contact:remoteContact}).safeParse(await transport.request(`/books/v3/contacts/${id}`));
  if(!value.success||value.data.contact.contact_id!==id)throw block("VENDOR_CONFIRMATION_INVALID","Books did not return a verifiable supplier identity.");
  return value.data.contact;
}
function matchesContact(contact:RemoteContact,snapshot:VendorSyncSnapshot,created:boolean) {
  const v=snapshot.vendor;
  const expectedEmail=v.email;
  const emails=[contact.email,...(contact.contact_persons??[]).map(p=>p.email)].filter((x):x is string=>typeof x==="string");
  return contact.status==="active"&&fold(contact.contact_name)===fold(v.name)&&contact.currency_code===v.currency&&
    contact.tax_treatment===snapshot.payload.tax_treatment&&
    (!v.trn||typeof contact.tax_reg_no==="string"&&fold(contact.tax_reg_no)===fold(v.trn))&&
    (!expectedEmail||emails.some(e=>fold(e)===fold(expectedEmail)))&&
    (!created||typeof contact.notes==="string"&&contact.notes.split(/\r?\n/).some(line=>line.endsWith("Reference: "+snapshot.marker)));
}
async function candidates(transport:ZohoTransport,query:Record<string,string>) {
  const ids=new Set<string>();
  for(let page=1;page<=5;page++) {
    const value=z.object({code:z.literal(0),contacts:z.array(z.object({contact_id:z.string().regex(/^\d{1,30}$/)})).max(200),
      page_context:z.object({page:z.number().int(),has_more_page:z.boolean()})}).safeParse(await transport.request("/books/v3/contacts",{
        query:{contact_type:"vendor",filter_by:"Status.All",...query,page:String(page),per_page:"200"}}));
    if(!value.success||value.data.page_context.page!==page)throw block("VENDOR_SEARCH_INVALID","Books supplier search was incomplete; no supplier was created.");
    value.data.contacts.forEach(c=>ids.add(c.contact_id));
    if(!value.data.page_context.has_more_page)return [...ids];
  }
  throw block("VENDOR_SEARCH_INCOMPLETE","Too many matching Books suppliers. Review the supplier identity before synchronization.");
}
async function findExisting(transport:ZohoTransport,snapshot:VendorSyncSnapshot,reconciliation:boolean) {
  // Some Books organizations ignore name-specific filters. Text search is
  // bounded and complete here; the exact supplier name is still checked below.
  const ids=await candidates(transport,{search_text:reconciliation?snapshot.marker:snapshot.vendor.name.slice(0,100)});
  if(ids.length>50)throw block("VENDOR_SEARCH_INCOMPLETE","Too many similar suppliers require administrator review; no contact was created.");
  const contacts=await Promise.all(ids.map(id=>readContact(transport,id)));
  const exact=contacts.filter(c=>fold(c.contact_name)===fold(snapshot.vendor.name));
  if(reconciliation) {
    const proven=exact.filter(c=>matchesContact(c,snapshot,true));
    if(proven.length>1)throw block("VENDOR_IDENTITY_AMBIGUOUS","Several Books contacts match this saved operation. An administrator must review them.");
    return proven[0]??null;
  }
  if(exact.length>1)throw block("VENDOR_IDENTITY_AMBIGUOUS","Several Books suppliers have this name. Select and verify the intended existing supplier.");
  if(exact.length===1) {
    if(!matchesContact(exact[0],snapshot,false))throw block("VENDOR_DETAILS_CONFLICT","The existing Books supplier has different currency, VAT, email or activity details. Review its mapping; no duplicate was created.");
    return exact[0];
  }
  return null;
}
async function verifyCurrency(transport:ZohoTransport,snapshot:VendorSyncSnapshot) {
  const value=z.object({code:z.literal(0),currencies:z.array(z.object({currency_id:z.string(),currency_code:z.string(),
    is_enabled:z.boolean().optional()}))}).safeParse(await transport.request("/books/v3/settings/currencies"));
  if(!value.success||!value.data.currencies.some(c=>c.currency_id===snapshot.payload.currency_id&&c.currency_code===snapshot.vendor.currency&&c.is_enabled!==false))
    throw block("VENDOR_CURRENCY_MISMATCH","The Books currency does not match this supplier. No contact was sent.");
}
async function complete(job:VendorBooksSync,leaseToken:string,snapshot:VendorSyncSnapshot,config:ZohoConfig,contact:RemoteContact) {
  if(!matchesContact(contact,snapshot,false))throw block("VENDOR_CONFIRMATION_MISMATCH","The returned Books supplier does not match the saved supplier details.");
  await assertVendorSyncSource(job,snapshot,config);
  await db.$transaction(async tx=>{
    await managementActor({id:job.initiatedById,role:"ACCOUNTS"},job.companyId,tx);
    const current=await tx.vendorBooksSync.findFirst({where:{id:job.id,leaseToken,status:"PROCESSING",leaseUntil:{gt:new Date()}}});
    const vendor=await tx.vendor.findUnique({where:{id:job.vendorId},select:vendorSourceFields});
    if(!current||!vendor||vendorSnapshotHash(sourceOf(vendor))!==vendorSnapshotHash(snapshot.vendor))throw new HttpError(409,"The saved supplier operation changed. Check its result before retrying.");
    const destination={organizationId:job.organizationId,dataCenter:job.dataCenter,environment:job.environment};
    const collision=await tx.vendorBooksMapping.findFirst({where:{...destination,externalVendorId:contact.contact_id,vendorId:{not:job.vendorId}}});
    if(collision)throw block("VENDOR_MAPPING_CONFLICT","This Books supplier belongs to another saved vendor. An administrator must review the existing records.");
    const mapping=await tx.vendorBooksMapping.findUnique({where:{vendorId_organizationId_dataCenter_environment:{vendorId:job.vendorId,...destination}}});
    if(mapping&&mapping.externalVendorId!==contact.contact_id)throw block("VENDOR_MAPPING_CONFLICT","The supplier already has another verified Books mapping.");
    await tx.vendorBooksMapping.upsert({where:{vendorId_organizationId_dataCenter_environment:{vendorId:job.vendorId,...destination}},
      create:{vendorId:job.vendorId,...destination,externalVendorId:contact.contact_id},update:{}});
    await tx.vendorBooksSync.update({where:{id:job.id},data:{status:"SYNCED",externalVendorId:contact.contact_id,completedAt:new Date(),
      leaseToken:null,leaseUntil:null,lastError:null,errorCode:null}});
    await tx.auditLog.create({data:{actorId:job.initiatedById,companyId:job.companyId,action:"VENDOR_BOOKS_SYNC_CONFIRMED",entityType:"Vendor",entityId:job.vendorId,
      details:{...destination,externalVendorId:contact.contact_id}}});
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

/** A submitted/expired operation is reconciled by marker; it is never blindly recreated. */
export async function synchronizeVendor(actor:Actor,vendorId:string,factory:VendorTransportFactory=transportFor,expectedJobId?:string):Promise<VendorSyncSummary> {
  const vendor=await db.vendor.findUnique({where:{id:vendorId},select:vendorSourceFields});
  if(!vendor)throw new HttpError(404,"Supplier not found.");
  const selected=await plan(actor,vendor.companyId);
  const pinned=expectedJobId?await db.vendorBooksSync.findFirst({where:{id:expectedJobId,vendorId,companyId:vendor.companyId}}):null;
  if(expectedJobId&&!pinned)throw new HttpError(404,"Saved supplier operation not found.");
  if(pinned&&(!selected.config||pinned.organizationId!==selected.config.organizationId||pinned.dataCenter!==selected.config.dataCenter||pinned.environment!==selected.config.environment)) {
    await db.vendorBooksSync.updateMany({where:{id:pinned.id,status:{not:"SYNCED"},OR:[{leaseUntil:null},{leaseUntil:{lte:new Date()}}]},
      data:{status:"BLOCKED",errorCode:"VENDOR_DESTINATION_CHANGED",lastError:"The original supplier destination changed. Review its saved result before starting another operation."}});
    return summary(vendorId,await db.vendorBooksSync.findUnique({where:{id:pinned.id}}));
  }
  if(!selected.config)return summary(vendorId,null,selected.local?"LOCAL_ONLY":"BLOCKED",selected.message??undefined);
  const config=selected.config;
  if(!pinned&&await db.vendorBooksSync.findFirst({where:{vendorId,submittedAt:{not:null},status:{not:"SYNCED"},
    NOT:{organizationId:config.organizationId,dataCenter:config.dataCenter,environment:config.environment}},select:{id:true}}))
    return summary(vendorId,null,"BLOCKED","An earlier supplier submission in another Books destination still needs reconciliation. No new contact was created.");
  const mapped=await db.vendorBooksMapping.findUnique({where:{vendorId_organizationId_dataCenter_environment:{vendorId,organizationId:config.organizationId,dataCenter:config.dataCenter,environment:config.environment}}});
  if(mapped)return vendor.externalZohoId&&vendor.externalZohoId!==mapped.externalVendorId
    ?summary(vendorId,null,"BLOCKED","The legacy supplier ID conflicts with its verified Books mapping. Administrator review is required.")
    :summary(vendorId,{status:"SYNCED",lastError:null,organizationId:config.organizationId,externalVendorId:mapped.externalVendorId});
  const otherMapping=await db.vendorBooksMapping.findFirst({where:{vendorId,NOT:{organizationId:config.organizationId,dataCenter:config.dataCenter,environment:config.environment}},select:{id:true}});
  if(vendor.externalZohoId||otherMapping) {
    if(pinned)await db.vendorBooksSync.updateMany({where:{id:pinned.id,status:{not:"SYNCED"},OR:[{leaseUntil:null},{leaseUntil:{lte:new Date()}}]},
      data:{status:"BLOCKED",errorCode:"VENDOR_LEGACY_IDENTITY_REVIEW",lastError:"An existing supplier identity needs administrator review before automatic synchronization."}});
    return summary(vendorId,null,"BLOCKED","This supplier has a legacy or other-destination Books identity. Ask an administrator to verify its exact mapping; no contact was created.");
  }
  let job:VendorBooksSync;
  try {job=pinned??await db.$transaction(tx=>enqueue(tx,actor,vendor,config),{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});}
  catch(error){if(error instanceof IntegrationError)return summary(vendorId,null,"BLOCKED",error.message);throw error;}
  const now=new Date(),leaseToken=randomBytes(32).toString("hex");
  const claimed=await db.vendorBooksSync.updateMany({where:{id:job.id,status:{not:"SYNCED"},OR:[{leaseUntil:null},{leaseUntil:{lte:now}}]},
    data:{status:"PROCESSING",leaseToken,leaseUntil:new Date(now.getTime()+10*60_000),initiatedById:actor.id,attempts:{increment:1},lastError:null,errorCode:null}});
  if(!claimed.count)return summary(vendorId,await db.vendorBooksSync.findUnique({where:{id:job.id}}));
  job=await db.vendorBooksSync.findUniqueOrThrow({where:{id:job.id}});
  let submitted=Boolean(job.submittedAt);
  let newlyArmed=false, writerReturned=false;
  try {
    const snapshot=vendorSyncSnapshotSchema.parse(job.snapshot);
    if(job.sourceHash!==vendorSnapshotHash(snapshot))throw block("VENDOR_SOURCE_CHANGED","The saved supplier operation cannot be verified.");
    await assertVendorSyncSource(job,snapshot,config);
    const reader=factory(config);
    const found=job.externalVendorId?await readContact(reader,job.externalVendorId):await findExisting(reader,snapshot,submitted);
    if(found) {await complete(job,leaseToken,snapshot,config,found);}
    else if(submitted) {
      await db.vendorBooksSync.updateMany({where:{id:job.id,leaseToken},data:{status:"UNKNOWN",leaseToken:null,leaseUntil:null,
        nextAttemptAt:new Date(Date.now()+Math.min(3600,30*2**Math.min(job.attempts,7))*1000),
        errorCode:"VENDOR_RESULT_UNCONFIRMED",lastError:messages.UNKNOWN}});
    } else {
      await verifyCurrency(reader,snapshot);assertWrite(config);
      await assertVendorSyncSource(job,snapshot,config);
      const armed=await db.vendorBooksSync.updateMany({where:{id:job.id,leaseToken,status:"PROCESSING",leaseUntil:{gt:new Date()},submittedAt:null},data:{submittedAt:new Date()}});
      if(!armed.count)throw new HttpError(409,"The supplier operation changed before submission.");
      submitted=true;
      newlyArmed=true;
      const writer=factory(config,vendorContactCapability(job.id,leaseToken));
      const raw=await writer.request("/books/v3/contacts",{method:"POST",body:snapshot.payload});
      writerReturned=true;
      const response=z.object({code:z.literal(0),contact:remoteContact}).safeParse(raw);
      if(!response.success||!matchesContact(response.data.contact,snapshot,true))throw new IntegrationError("VENDOR_RESPONSE_UNVERIFIED",messages.UNKNOWN,"UNKNOWN");
      await db.vendorBooksSync.updateMany({where:{id:job.id,leaseToken},data:{externalVendorId:response.data.contact.contact_id}});
      const verified=await readContact(reader,response.data.contact.contact_id);
      if(!matchesContact(verified,snapshot,true))throw new IntegrationError("VENDOR_CONFIRMATION_MISMATCH",messages.UNKNOWN,"UNKNOWN");
      await complete(job,leaseToken,snapshot,config,verified);
    }
  }catch(error) {
    const safe=error instanceof IntegrationError?error:new IntegrationError("VENDOR_SYNC_INTERRUPTED","Supplier synchronization could not be confirmed. Check the saved result before retrying.",submitted?"UNKNOWN":"BLOCKED");
    // A GET failure while reconciling an older uncertain submission must never
    // erase the durable send marker and turn a later retry into another POST.
    const definitelyRejected=newlyArmed&&!writerReturned&&["AUTHORIZATION_REQUIRED","REMOTE_REJECTED"].includes(safe.code);
    const unknown=submitted&&!definitelyRejected;
    const status=unknown?"UNKNOWN":safe.kind==="FAILED"?"FAILED":"BLOCKED";
    await db.vendorBooksSync.updateMany({where:{id:job.id,leaseToken},data:{status,leaseToken:null,leaseUntil:null,
      ...(definitelyRejected?{submittedAt:null}:{}),nextAttemptAt:new Date(Date.now()+60_000),errorCode:safe.code,
      lastError:(safe.code==="AUTHORIZATION_REQUIRED"?"Books authorization must permit supplier creation. Ask an administrator to reconnect this company's Books account.":safe.message).slice(0,500)}});
  }
  return summary(vendorId,await db.vendorBooksSync.findUnique({where:{id:job.id}}));
}

export async function processVendorBooksSyncs(limit=5,factory:VendorTransportFactory=transportFor) {
  const now=new Date();
  const jobs=await db.vendorBooksSync.findMany({where:{status:{in:["QUEUED","UNKNOWN","PROCESSING"]},nextAttemptAt:{lte:now},
    OR:[{leaseUntil:null},{leaseUntil:{lte:now}}]},orderBy:{createdAt:"asc"},take:Math.max(1,Math.min(25,limit))});
  let processed=0;
  for(const job of jobs) {
    const actor=await db.user.findUnique({where:{id:job.initiatedById},select:{id:true,role:true,active:true,email:true,name:true}});
    if(!actor?.active||!["ADMIN","ACCOUNTS"].includes(actor.role)) {
      await db.vendorBooksSync.updateMany({where:{id:job.id,OR:[{leaseUntil:null},{leaseUntil:{lte:now}}]},data:{status:"BLOCKED",leaseToken:null,leaseUntil:null,
        errorCode:"VENDOR_ACTOR_UNAVAILABLE",lastError:"An active supplier manager must review and retry this operation."}});continue;
    }
    try{await synchronizeVendor(actor,job.vendorId,factory,job.id);processed++;}
    catch{await db.vendorBooksSync.updateMany({where:{id:job.id,status:{not:"SYNCED"},OR:[{leaseUntil:null},{leaseUntil:{lte:new Date()}}]},
      data:{status:"BLOCKED",errorCode:"VENDOR_SOURCE_UNAVAILABLE",lastError:"Current supplier-management access and the original saved source must be reviewed."}});}
  }
  return{processed};
}
