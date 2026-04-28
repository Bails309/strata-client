// Quick helper: print non-a11y-label correctness errors from ESLint JSON.
import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync(process.argv[2], "utf8"));
const skip = new Set(["jsx-a11y/label-has-associated-control", "jsx-a11y/no-autofocus"]);
const out = [];
for (const f of j) {
  for (const m of f.messages) {
    if (m.severity === 2 && !skip.has(m.ruleId)) {
      out.push(`${f.filePath.replace(process.cwd(), "")}:${m.line}:${m.column}  ${m.ruleId}: ${m.message.slice(0, 100)}`);
    }
  }
}
out.sort();
for (const l of out) console.log(l);
console.log(`\nTotal: ${out.length}`);
