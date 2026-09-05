import fs from 'node:fs';
import path from 'node:path';
const files=fs.readdirSync('.').filter(f=>f.endsWith('.html'));
const errors=[];
for(const file of files){
 const html=fs.readFileSync(file,'utf8');
 for(const [,reference] of html.matchAll(/(?:href|src)="([^"]+)"/g)){
  if(/^(https?:|mailto:|data:|#)/.test(reference))continue;
  const local=reference.split(/[?#]/)[0];
  if(!fs.existsSync(path.resolve(local)))errors.push(`${file}: missing ${local}`);
 }
 for(const property of ['og:image','twitter:image']){
  const match=html.match(new RegExp(`(?:property|name)="${property}"\\s+content="([^"]+)"`));
  if(!match)errors.push(`${file}: missing ${property}`);
  else {const asset=new URL(match[1]).pathname.slice(1);if(!fs.existsSync(asset))errors.push(`${file}: missing social image ${asset}`);}
 }
 if((html.match(/<h1\b/g)||[]).length!==1)errors.push(`${file}: expected one H1`);
 if((html.match(/<main\b/g)||[]).length!==1)errors.push(`${file}: expected one main`);
}
if(errors.length){console.error(errors.join('\n'));process.exit(1);}
console.log(`Checked ${files.length} pages: local references, social assets, and main headings are valid.`);
