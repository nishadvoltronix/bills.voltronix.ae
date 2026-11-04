import { requireUser } from "@/lib/auth";
import { handle, json, readJson, sameOrigin } from "@/lib/http";
import { getVendorSync, synchronizeVendor } from "@/lib/services/vendor-books-sync";
import { z } from "zod";
export async function GET(_request:Request,context:{params:Promise<{id:string}>}) {
  return handle(async()=>json({sync:await getVendorSync(await requireUser(),(await context.params).id)}));
}
export async function POST(request:Request,context:{params:Promise<{id:string}>}) {
  return handle(async()=>{
    sameOrigin(request);
    z.object({action:z.enum(["sync","retry","reconcile"]).optional()}).strict().parse(await readJson(request,1024));
    return json({sync:await synchronizeVendor(await requireUser(),(await context.params).id)});
  });
}
