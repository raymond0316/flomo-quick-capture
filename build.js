const fs=require('node:fs');
fs.mkdirSync('dist/flomo-quick-capture',{recursive:true});
const ids=['main','capture','count','paths','tags','drafts','viewport','cleanup','review'];
const bodies=ids.map(id => `${JSON.stringify('./'+id)}:function(module,exports,require){\n${fs.readFileSync(id+'.js','utf8')}\n}`).join(',\n');
fs.writeFileSync('dist/flomo-quick-capture/main.js',`const nativeRequire=require;const factories={${bodies}};const cache={};function load(id){if(!factories[id])return nativeRequire(id);if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;factories[id](m,m.exports,load);return m.exports;}module.exports=load('./main');\n`);
for (const file of ['manifest.json','styles.css']) fs.copyFileSync(file,'dist/flomo-quick-capture/'+file);
