import { isolatedProviderEnvironment } from "../scripts/lib/test-provider-environment.mjs";

const isolated = isolatedProviderEnvironment(process.env);
for (const key of Object.keys(process.env)) {
  if (!(key in isolated)) delete process.env[key];
}
Object.assign(process.env, isolated);
