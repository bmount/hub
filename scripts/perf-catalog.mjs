#!/usr/bin/env node
// Only source literals enter this catalog. Dynamic SQL is never exported as text.
import ts from 'typescript';
import {readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
const normalize = sql => sql.replace(/'(?:''|[^'])*'|\b\d+(?:\.\d+)?\b/g,'?').replace(/--[^\n]*|\/\*[\s\S]*?\*\//g,' ').replace(/\s+/g,' ').trim().toLowerCase();
const hash = text => { let h=2166136261; for(let i=0;i<text.length;i++) h=Math.imul(h^text.charCodeAt(i),16777619); return (h>>>0).toString(16).padStart(8,'0'); };
const sql={}, spans={}, functions={}, classes={};
async function scan(dir) {
 for(const entry of await readdir(dir,{withFileTypes:true})) {
  const file=path.posix.join(dir,entry.name);
  if(entry.isDirectory()) {await scan(file);continue;}
  if(!file.endsWith('.ts') || file==='src/perfCatalog.ts') continue;
  const content=await readFile(file,'utf8');
  const source=ts.createSourceFile(file,content,ts.ScriptTarget.Latest,true), annotations=[];
  const literal = n => n && (ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
  function location(node) {
   let fn='module';
   for(let p=node.parent;p;p=p.parent) {
    if((ts.isFunctionDeclaration(p)||ts.isMethodDeclaration(p)) && p.name) {fn=p.name.getText(source);break;}
    if(ts.isVariableDeclaration(p) && p.name) {fn=p.name.getText(source);break;}
   }
   const pos=source.getLineAndCharacterOfPosition(node.getStart(source));
   return {file,line:pos.line+1,column:pos.character+1,fn};
  }
  function visit(node) {
   if(ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name) {
    const method=node.name.getText(source), klass=node.parent.name.text,loc={...location(node),fn:`${klass}.${method}`};
    (classes[file+':'+klass]??={})[method]=loc;
    if(['Conversation','Inbox'].includes(klass)) spans[`do.handler.${klass}.${method}`]=loc;
   }
   if(ts.isFunctionDeclaration(node) && node.name) functions[node.name.text]={file,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,fn:node.name.text};
   if(ts.isCallExpression(node)) {
    const callee=node.expression.getText(source), text=literal(node.arguments[0]);
    if(callee==='tracedInvocation') {const label=literal(node.arguments[2]);if(label)spans[label]=location(node);}
    if(callee==='instrumentMethods') {
     const prefix=literal(node.arguments[1]),klass=node.arguments[0]?.getText(source);
     if(prefix&&klass) for(const [method,loc] of Object.entries(classes[file+':'+klass]??{})) spans[prefix+'.'+method]=loc;
    }
    if(node.arguments[0] && (/\.prepare$/.test(callee) || /(?:db|DB)\.exec$/.test(callee))) {
     const loc=location(node), marker=`/*perf-site:${encodeURIComponent(loc.file)}:${loc.line}:${loc.column}:${encodeURIComponent(loc.fn)}*/ `;
     let arg=node.arguments[0], prefix=null;
     if(ts.isBinaryExpression(arg) && arg.operatorToken.kind===ts.SyntaxKind.PlusToken && literal(arg.left)?.startsWith('/*perf-site:') && ts.isParenthesizedExpression(arg.right)) {prefix=arg.left;arg=arg.right.expression;}
     const value=literal(arg), template=ts.isTemplateExpression(arg);
     if(process.argv.includes('--annotate') && file!=='src/perf.ts') {
      if(prefix) {if(literal(prefix)!==marker)annotations.push({at:prefix.getStart(source),end:prefix.end,text:JSON.stringify(marker)});}
      else if(value!==null || template) {
       const head=value??arg.head.text,old=/^\/\*perf-site:[^*]+\*\/ /.exec(head)?.[0]??'';
       if(old!==marker)annotations.push({at:arg.getStart(source)+1,end:arg.getStart(source)+1+old.length,text:marker});
      } else annotations.push({at:arg.getStart(source),end:arg.end,text:JSON.stringify(marker)+' + ('+arg.getText(source)+')'});
     }
     let statement;
     if(value!==null)statement=normalize(value);
     else if(template)statement=normalize(arg.head.text+arg.templateSpans.map(s=>'${'+s.expression.getText(source)+'}'+s.literal.text).join(''));
     else statement='SQL expression: '+normalize(arg.getText(source));
     const siteKey='site-'+hash(marker),existing=sql[siteKey];
     if(existing) throw new Error('SQL site hash collision');
     sql[siteKey]={text:statement,sites:[loc],template:value===null};
     if(value!==null) {
      const key=hash(statement);
      if(sql[key] && sql[key].text!==statement) throw new Error('SQL catalog hash collision');
      (sql[key]??={text:statement,sites:[]}).sites.push(loc);
     }
    }
    if(text && ['span','spanFunction'].includes(callee)) spans[text]=location(node);
    if(callee==='defineVerb' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
     const name=node.arguments[0].properties.find(p=>ts.isPropertyAssignment(p) && p.name.getText(source)==='name');
     const value=name && literal(name.initializer);if(value) {spans['verb.'+value]=location(node);spans['mcp.'+value.replaceAll('.','_')]=location(node);}
    }
    if(text && /^app\.(get|post|put|delete|all)$/.test(callee)) spans['route.'+text]=location(node);
   }
   ts.forEachChild(node,visit);
  }
  visit(source);
  if(annotations.length) {
   let updated=content;
   for(const edit of annotations.sort((a,b)=>b.at-a.at)) updated=updated.slice(0,edit.at)+edit.text+updated.slice(edit.end);
   await writeFile(file,updated);
  }
 }
}
await scan('src');await scan('git-proxy');
await writeFile('src/perfCatalog.ts','// Generated by scripts/perf-catalog.mjs; source literals only.\nexport type CodeSite = {file:string;line:number;column?:number;fn:string};\nexport const SQL_CATALOG: Record<string,{text:string;sites:CodeSite[];template?:boolean}> = '+JSON.stringify(sql)+';\nexport const SPAN_CATALOG: Record<string,CodeSite> = '+JSON.stringify(spans)+';\nexport const FUNCTION_CATALOG: Record<string,CodeSite> = '+JSON.stringify(functions)+';\n');
console.log(`Performance catalog: ${Object.keys(sql).length} SQL literals, ${Object.keys(spans).length} span sources`);
