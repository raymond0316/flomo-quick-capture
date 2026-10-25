const {normalizePath} = require('obsidian');
function cleanFolder(value) {
  const path = value.trim().replace(/\\/g,'/').replace(/\/+$/,'');
  if (!path || path.startsWith('/') || /(^|\/)\.\.?($|\/)/.test(path) || /[:*?"<>|\[\]#^]/.test(path)) {
    throw new Error('请输入 Vault 内的相对文件夹路径，不含 .. 或特殊字符。');
  }
  return normalizePath(path);
}
async function ensureFolder(vault,path) {
  let current = '';
  for (const part of path.split('/')) {
    current = current ? current + '/' + part : part;
    const existing = vault.getAbstractFileByPath(current);
    if (existing) {
      if (!('children' in existing)) throw new Error('目标文件夹路径已被文件占用。');
      continue;
    }
    try { await vault.createFolder(current); }
    catch (error) { if (!vault.getAbstractFileByPath(current)) throw error; }
  }
}
module.exports = {cleanFolder,ensureFolder};
