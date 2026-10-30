import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import { getConfig } from "@/lib/integrations/config";
import { ZohoTransport, type Fetch } from "@/lib/integrations/transport";
import { parseBooksCatalogPage, readBooksAccountingCatalog } from "@/lib/services/books-accounting-catalog";

const store = vi.hoisted(() => ({ user:{findFirst:vi.fn()}, companyIntegrationDestination:{findFirst:vi.fn()} }));
vi.mock("@/lib/db",()=>({db:store}));
vi.mock("@/lib/integrations/oauth",()=>({accessToken:vi.fn(async()=>"fictional-token")}));
const actor:Actor={id:"operator",role:"ADMIN",name:"Fictional operator",email:"operator@example.invalid"};
const input={companyId:"connection-check-books-1001",organizationId:"1001"};
const binding={...input,target:"ZOHO",dataCenter:"US",environment:"production",liveEnabled:false,
  company:{id:input.companyId,name:"[CONNECTION CHECK] Fictional Company",active:true,isDemo:true,liveAccountingEnabled:false}};
const account={account_id:"201",account_name:"Fictional materials",account_type:"expense",is_active:true};
const currency={currency_id:"101",currency_name:"UAE Dirham",currency_code:"AED",is_base_currency:true,price_precision:2};
const tax={tax_id:"301",tax_name:"Fictional standard VAT",tax_type:"tax",tax_percentage:5};
beforeEach(()=>{
  vi.resetAllMocks();
  for (const [key,value] of Object.entries({
    APP_ENV:"development",APP_URL:"http://127.0.0.1:3000",DATABASE_URL:"mysql://billing_app:fictional@127.0.0.1:3308/voltronix_billing_dev",
    INTEGRATION_TEST_MODE:"false",ZOHO_BOOKS_WRITE_ENABLED:"false",ZOHO_BOOKS_LIVE_ENABLED:"false",ALLOW_PRODUCTION_ACCOUNTING_WRITES:"false",
    INTEGRATION_NETWORK_ENABLED:"true",ZOHO_BOOKS_NETWORK_ENABLED:"true",ZOHO_BOOKS_DC:"US",ZOHO_BOOKS_ENVIRONMENT:"production",
    ZOHO_BOOKS_CLIENT_ID:"fictional-client",ZOHO_BOOKS_CLIENT_SECRET:"fictional-secret",
    ZOHO_BOOKS_ORGANIZATIONS_JSON:JSON.stringify([{organizationId:"1001",name:"Fictional Company"}]),
  })) vi.stubEnv(key,value);
  store.user.findFirst.mockResolvedValue({id:actor.id});
  store.companyIntegrationDestination.findFirst.mockResolvedValue(binding);
  vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("Unmocked network forbidden");}));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});

function connection(handler?:(path:string,page:string|null)=>unknown) {
  const fetcher=vi.fn<Fetch>(async(url,options)=>{
    const parsed=new URL(url);
    expect(options?.method).toBe("GET");
    expect(parsed.searchParams.get("organization_id")).toBe("1001");
    const body=handler?.(parsed.pathname,parsed.searchParams.get("page")) ?? {
      "/books/v3/organizations/1001":{code:0,organization:{organization_id:"1001",name:"Fictional Company",is_org_active:true,currency_id:"101",currency_code:"AED",price_precision:2,email:"private@example.invalid"}},
      "/books/v3/chartofaccounts":{code:0,chartofaccounts:[account]},
      "/books/v3/settings/currencies":{code:0,currencies:[currency]},
      "/books/v3/settings/taxes":{code:0,taxes:[tax]},
    }[parsed.pathname];
    return new Response(JSON.stringify(body),{status:200});
  });
  return {fetcher,transport:new ZohoTransport(getConfig("ZOHO",process.env,"1001"),async()=>"fictional-token",fetcher)};
}

describe("Books accounting catalog response validation",()=>{
  it("returns only bounded IDs, labels and supported mapping options, stripping balances and unknown fields",()=>{
    const result=parseBooksCatalogPage("accounts",{code:0,chartofaccounts:[{...account,current_balance:999999,secret:"never-output"}],page_context:{page:1,has_more_page:false}},1);
    expect(result).toEqual({entries:[{id:"201",label:"Fictional materials",type:"expense",active:true,supported:true}],hasMore:false});
    expect(JSON.stringify(result)).not.toContain("999999");
  });
  it("identifies unsupported compound taxes and precision without selecting a mapping",()=>{
    expect(parseBooksCatalogPage("taxes",{code:0,taxes:[{...tax,tax_type:"compound_tax"}]},1).entries[0].supported).toBe(false);
    expect(parseBooksCatalogPage("currencies",{code:0,currencies:[{...currency,price_precision:0}]},1).entries[0].supported).toBe(false);
  });
  it.each([
    { status: "inactive" },
    { status: "Inactive" },
    { status: "inactive", is_active: true },
    { status: "active", is_active: false },
  ])("rejects explicitly inactive tax status regardless of the other indicator: %j", (activity) => {
    expect(parseBooksCatalogPage("taxes", { code: 0, taxes: [{ ...tax, ...activity }] }, 1).entries[0])
      .toMatchObject({ active: false, supported: false });
  });
  it("accepts active status without is_active and rejects unknown status values", () => {
    for (const status of ["active", "Active"]) {
      expect(parseBooksCatalogPage("taxes", { code: 0, taxes: [{ ...tax, status }] }, 1).entries[0])
        .toMatchObject({ active: true, supported: true });
    }
    expect(() => parseBooksCatalogPage("taxes", { code: 0, taxes: [{ ...tax, status: "unknown" }] }, 1)).toThrow();
  });
  it.each(["duplicate","control-label","wrong-page","oversized"])("rejects %s metadata",(kind)=>{
    const response={code:0,chartofaccounts:[account],page_context:{page:1,has_more_page:false}};
    if(kind==="duplicate") response.chartofaccounts.push(account);
    if(kind==="control-label") response.chartofaccounts=[{...account,account_name:"unsafe\u001b[31m"}];
    if(kind==="wrong-page") response.page_context.page=2;
    if(kind==="oversized") response.chartofaccounts=Array.from({length:101},(_,i)=>({...account,account_id:String(i+1)}));
    expect(()=>parseBooksCatalogPage("accounts",response,1)).toThrow();
  });
});

describe("read-only company-scoped catalog",()=>{
  it("reads the exact authorized local connection-check destination without changing accounting configuration",async()=>{
    const {transport,fetcher}=connection();
    const catalog=await readBooksAccountingCatalog(actor,input,transport);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(catalog).toMatchObject({companyId:input.companyId,providerReads:4,providerFinancialWrites:0,accountingConfigurationWrites:0,mappingsSelected:false});
    expect(catalog.accounts).toHaveLength(1);
    expect(JSON.stringify(catalog)).not.toContain("private@example.invalid");
    expect(JSON.stringify(catalog)).not.toContain("fictional-token");
  });
  it("follows explicit pagination and returns all unique bounded options",async()=>{
    const {transport}=connection((path,page)=>path.endsWith("/chartofaccounts") ? {code:0,chartofaccounts:[{...account,account_id:page==="1"?"201":"202"}],page_context:{page:Number(page),has_more_page:page==="1"}}:undefined);
    const catalog=await readBooksAccountingCatalog(actor,input,transport);
    expect(catalog.accounts.map(row=>row.id)).toEqual(["201","202"]);
    expect(catalog.providerReads).toBe(5);
  });
  it("rejects repeated pages instead of silently returning an incomplete catalog",async()=>{
    const {transport}=connection(path=>path.endsWith("/chartofaccounts")?{code:0,chartofaccounts:[account],page_context:{has_more_page:true}}:undefined);
    await expect(readBooksAccountingCatalog(actor,input,transport)).rejects.toMatchObject({code:"CATALOG_RESPONSE_INVALID"});
  });
  it("stops oversized catalogs at the page bound",async()=>{
    const {transport,fetcher}=connection((path,page)=>path.endsWith("/chartofaccounts")?{code:0,chartofaccounts:[{...account,account_id:String(Number(page)+200)}],page_context:{page:Number(page),has_more_page:true}}:undefined);
    await expect(readBooksAccountingCatalog(actor,input,transport)).rejects.toMatchObject({code:"CATALOG_LIMIT_REACHED"});
    expect(fetcher).toHaveBeenCalledTimes(11);
  });
  it("denies a different company before contacting the provider",async()=>{
    store.companyIntegrationDestination.findFirst.mockResolvedValue(null);
    const {transport,fetcher}=connection();
    await expect(readBooksAccountingCatalog(actor,{...input,companyId:"another-company"},transport)).rejects.toMatchObject({code:"COMPANY_DESTINATION_MISMATCH"});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rechecks access before returning metadata",async()=>{
    store.user.findFirst.mockResolvedValueOnce({id:actor.id}).mockResolvedValueOnce(null);
    await expect(readBooksAccountingCatalog(actor,input,connection().transport)).rejects.toMatchObject({status:403});
  });
});
