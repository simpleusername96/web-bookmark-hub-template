"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { openRegistry } = require("../registry/database.js");
const { addEntry } = require("../registry/entries.js");
const { createFolder } = require("../registry/folders.js");
const { addTags } = require("../registry/tags.js");
const { addComment } = require("../registry/comments.js");
const { createSummaryJob, completeSummaryJob } = require("../registry/summaries.js");
const { addLocalImage } = require("../registry/visual-assets.js");
const records = require("../examples/demo-records.js");
const { png } = require("../examples/demo-covers.js");

async function seedDemo(dbPath = path.resolve(__dirname, "..", "data", "demo.sqlite3")) {
  if (fs.existsSync(dbPath)) throw new Error("Demo database already exists. Use a new demo path; existing data is never overwritten.");
  const registry = openRegistry({ dbPath });
  try {
    const folders = {};
    for (const [key,name] of [["research","리서치"],["design","디자인 레퍼런스"],["development","개발 도구"],["learning","학습 노트"]]) folders[key] = createFolder(registry,{name}).id;
    for (const [index, record] of records.entries()) {
      const [folder,kind,domain,slug,title,tags,summary,cover] = record;
      const savedAt = new Date(Date.UTC(2026,8,22,9)-index*3600000).toISOString();
      const entry = addEntry(registry,{url:`https://${domain}.example.test/${slug}`, title, kind, visibility:"normal", folderId:folders[folder], savedAt, typedMetadata:{demo:true}}).entry;
      addTags(registry,entry.id,tags.split(","));
      if (index === 0) addComment(registry,entry.id,"다음 인터뷰 질문지를 만들 때 참고하기.");
      const job=createSummaryJob(registry,entry.id,{requestedBy:"synthetic-demo-fixture"});
      completeSummaryJob(registry,job.id,summary);
      if (cover) {
        const file=path.join(registry.dataDir,`demo-${index}.png`);
        fs.writeFileSync(file,png(cover));
        try { await addLocalImage(registry,entry.id,file,{makeCover:true,sourceKind:"user_upload"}); }
        finally { fs.unlinkSync(file); }
      }
    }
    return {dbPath, entries:records.length, folders:Object.keys(folders).length, synthetic:true};
  } finally {registry.close();}
}
if (require.main===module) seedDemo().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports = {seedDemo};
