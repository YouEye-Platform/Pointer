import ts from 'typescript';
import {readFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const locales=['en','ru','es','de','fr'];
const read=locale=>JSON.parse(readFileSync(resolve(root,'src/messages',`${locale}.json`),'utf8'));
const english=read('en');
const placeholders=text=>[...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match=>match[1]))].sort();
for(const locale of locales){
  new Intl.NumberFormat(locale);
  const messages=read(locale);
  if(JSON.stringify(Object.keys(messages).sort())!==JSON.stringify(Object.keys(english).sort()))throw new Error(`Catalogue keys differ: ${locale}`);
  for(const [key,text]of Object.entries(messages)){
    if(typeof text!=='string'||!text.trim())throw new Error(`Empty message: ${locale}:${key}`);
    if(JSON.stringify(placeholders(text))!==JSON.stringify(placeholders(english[key])))throw new Error(`Placeholder mismatch: ${locale}:${key}`);
  }
}
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(resolve(dir,entry.name)):/\.tsx?$/.test(entry.name)?[resolve(dir,entry.name)]:[])}
function literalKeys(node) {
 if(!node)return [];
 if(ts.isStringLiteralLike(node))return [node.text];
 if(ts.isConditionalExpression(node))return [...literalKeys(node.whenTrue),...literalKeys(node.whenFalse)];
 return [];
}
// Literal catalogue keys, including conditional messages and navigation labels, must exist.
for(const file of files(resolve(root,'src'))){
 const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 if(ast.parseDiagnostics.length)throw new Error(`Invalid source ${file}: ${ts.flattenDiagnosticMessageText(ast.parseDiagnostics[0].messageText,' ')}`);
 function visit(node){
  if(ts.isCallExpression(node)&&node.expression.getText(ast)==='translateInterface') {
   for(const key of literalKeys(node.arguments[0]))if(!(key in english))throw new Error(`Missing message ${file}: ${key}`);
  }
  if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='NAV'&&node.initializer){
   for(const match of node.initializer.getText(ast).matchAll(/label:\s*"([^"]+)"/g))if(!(match[1]in english))throw new Error(`Missing navigation message: ${match[1]}`);
  }
  ts.forEachChild(node,visit);
 }visit(ast);
}
console.log(`Validated ${locales.length} Pointer catalogues, ${Object.keys(english).length} messages and placeholders.`);
