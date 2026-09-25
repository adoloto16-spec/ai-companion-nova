import fs from "node:fs";
import path from "node:path";

const schemaDir=path.resolve("contracts/schemas");
const output=path.resolve("contracts/src/generated-schemas.ts");
const entries={};

for(const file of fs.readdirSync(schemaDir).filter(name=>name.endsWith(".schema.json")).sort()){
  entries[file.replace(".schema.json","")]=JSON.parse(fs.readFileSync(path.join(schemaDir,file),"utf8"));
}

const source=
  'import type { JsonSchema } from "./index";\n\n' +
  'export const STANDARD_SCHEMAS: Record<string, JsonSchema> = ' +
  JSON.stringify(entries,null,2) +
  ' as unknown as Record<string, JsonSchema>;\n';

fs.writeFileSync(output,source);
console.log("Generated "+Object.keys(entries).length+" schema artifacts.");
