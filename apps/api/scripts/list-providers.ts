import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { ModulesContainer } from "@nestjs/core/injector/modules-container";

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const modules = app.get(ModulesContainer);

  const lines: string[] = [];
  for (const [modName, mod] of modules.entries()) {
    for (const [token] of mod.providers) {
      const t = typeof token === "function" ? token.name : String(token);
      lines.push(`${modName} :: ${t}`);
    }
  }
  lines.sort();
  console.log(lines.join("\n"));
  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
