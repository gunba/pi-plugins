#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cases } from "./cases.mjs";

const args = process.argv.slice(2);
const opt = (name,fallback) => {const i=args.indexOf(`--${name}`);return i<0?fallback:args[i+1];};
const out = resolve(opt("out", "/tmp/pi-single-tool-bench"));
const repeats = Number(opt("repeats", "2")), jobs = Number(opt("jobs","4"));
const selected = opt("cases", "").split(",").filter(Boolean);
const models = opt("models","anthropic/claude-opus-5-5,openai-codex/gpt-6-sol").split(",");
const arms = opt("arms","current,single").split(",");
const queue = [];
for (let repeat=0;repeat<repeats;repeat++) for (const trial of cases.filter(c=>!selected.length||selected.includes(c.id))) for (const model of models) {
  for (const arm of repeat%2 ? [...arms].reverse():arms) queue.push({trial,model,arm,repeat});
}
await mkdir(out,{recursive:true});
await writeFile(join(out,"config.json"),JSON.stringify({repeats,jobs,models,arms,cases:cases.filter(c=>!selected.length||selected.includes(c.id)).map(c=>({id:c.id,group:c.group,prompt:c.prompt})),thinking:"high"},null,2));
const results=[];
await Promise.all(Array.from({length:jobs},async()=>{
  while(queue.length){
    const {trial,model,arm,repeat}=queue.shift();
    const name=`${model.replaceAll("/","-")}-${trial.id}-${arm}-${repeat}`;
    const directory=join(out,name);
    await mkdir(directory,{recursive:true});
    let done;
    try{done=JSON.parse(await readFile(join(directory,"done.json"),"utf8"));}catch{}
    if(!done){
      await trial.setup(directory);
      const env={...process.env}; delete env.PI_DESK_RUNTIME; delete env.PI_PACKAGE_DIR;
      await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[fileURLToPath(new URL("worker.mjs",import.meta.url)),arm,model,trial.id,directory],{cwd:directory,env,stdio:["ignore","pipe","pipe"]});
        let stderr="";child.stderr.on("data",d=>{stderr+=d;});child.stdout.on("data",()=>{});
        child.on("error",reject);
        child.on("close",async code=>{await writeFile(join(directory,"stderr.log"),stderr);if(code) console.error(`${name}: worker exited ${code}`);resolve();});
      });
      try{done=JSON.parse(await readFile(join(directory,"done.json"),"utf8"));}catch{done={arm,model,case:trial.id,failure:"Worker did not produce a result"};}
    }
    let trace=[];try{trace=(await readFile(join(directory,"trace.jsonl"),"utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);}catch{}
    let success=!done.failure,scoreError;
    try{await trial.score(directory,trace.filter(e=>e.event==="call"));}catch(error){success=false;scoreError=error.message;}
    const row={...done,repeat,group:trial.group,success,...(scoreError?{scoreError}:{}),definitionBytes:trace.find(e=>e.event==="definition")?.bytes,declared:trace.find(e=>e.event==="definition")?.names};
    await writeFile(join(directory,"score.json"),JSON.stringify(row,null,2));results.push(row);
    await writeFile(join(out,"results.json"),JSON.stringify(results,null,2));
    console.error(`${name}: ${success?"PASS":"FAIL"} ${done.seconds?.toFixed(1)}s${done.failure?` ${done.failure.split("\n")[0]}`:""}`);
  }
}));
