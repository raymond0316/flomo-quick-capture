const {Modal,normalizePath} = require('obsidian');
const {parseRecords} = require('./count');
const IMAGE = /\.(?:jpe?g|png|gif|webp|avif|bmp|heic|heif|tiff?|svg)$/i;
const EMBED = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\(([^)\s]+)\)/g;
// Same three-line rule as main.js isAnnual; kept in sync deliberately (see shared knowledge).
function isAnnualFile(file,folder) {
  return file.extension === 'md' && file.parent?.path === folder && /^\d{4}年\.md$/.test(file.name);
}
function recordTime(heading) {
  const date = new Date(heading.slice(0,10));
  return isNaN(date.getTime()) ? null : date.getTime();
}
function relativeDays(heading) {
  const record = new Date(heading.slice(0,10) + 'T00:00:00Z');
  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(),now.getMonth(),now.getDate()));
  const days = Math.round((today - record) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return days + ' 天前';
}
function recordBody(text,span) {
  const slice = text.slice(span.start,span.end);
  const first = slice.indexOf('\n');
  return first < 0 ? '' : slice.slice(first + 1);
}
function contentLines(body) {
  return body.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('![') && !/^-{3,}$/.test(line));
}
function buildPreview(body) {
  const text = contentLines(body).join(' ').replace(/\s+/g,' ').trim();
  return text.length > 120 ? text.slice(0,120) + '…' : text;
}
function fullBody(body) {
  return contentLines(body).join('\n');
}
// Same rule as tags.js tagContext: only line-start or whitespace-preceded # counts as a tag (URL fragments excluded).
function extractTags(body) {
  const seen = new Set(),tags = [];
  for (const line of contentLines(body)) {
    for (const match of line.matchAll(/(^|\s)#[^\s#，。]+/g)) {
      const tag = match[0].slice(match[1].length);
      if (!seen.has(tag)) { seen.add(tag); tags.push(tag); }
    }
  }
  return tags;
}
// Resolve an embed source against the annual file's folder first, then as-is; silently degrade to null.
function resolveImage(app,file,src) {
  const folder = file.parent?.path;
  const paths = folder ? [normalizePath(folder + '/' + src),normalizePath(src)] : [normalizePath(src)];
  for (const path of paths) {
    const target = app.vault.getAbstractFileByPath(path);
    if (target && !('children' in target) && IMAGE.test(target.path)) return target.path;
  }
  return null;
}
// Review day = local calendar date of (now - resetHour hours); join local Y/M/D manually, never toISOString.
function reviewDay(now,resetHour) {
  const hour = Math.min(23,Math.max(0,Math.round(Number(resetHour) || 0)));
  const shifted = new Date(now - hour * 3600e3);
  const pad = n => String(n).padStart(2,'0');
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`;
}
function dayLabel(day) {
  const parts = day.split('-');
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}
async function collectReviewEntries(plugin) {
  const {vault} = plugin.app;
  const folder = plugin.settings.noteFolder;
  const cutoff = plugin.settings.reviewRange === 'year' ? Date.now() - 365 * 24 * 60 * 60 * 1000 : 0;
  const entries = [];
  for (const file of vault.getMarkdownFiles()) {
    if (!isAnnualFile(file,folder)) continue;
    let text;
    try { text = await vault.read(file); } catch (_) { continue; }
    for (const span of parseRecords(text)) {
      const time = recordTime(span.heading);
      if (cutoff && (time === null || time < cutoff)) continue;
      const body = recordBody(text,span);
      let imagePath = null;
      for (const embed of body.matchAll(EMBED)) {
        imagePath = resolveImage(plugin.app,file,embed[1] || embed[2]);
        if (imagePath) break;
      }
      entries.push({
        file,year:Number(file.name.slice(0,4)),heading:span.heading,line:span.line,body,
        preview:buildPreview(body),text:fullBody(body),tags:extractTags(body),imagePath,
        hasAudio:/!\[\[[^\]]*recording-[^\]]*\]\]/.test(body) || /!\[[^\]]*\]\([^)]*recording-[^)]*\)/.test(body),
        key:file.path + '#' + span.heading
      });
    }
  }
  return entries;
}
// Pure Fisher-Yates sample: drop recently reviewed keys first, relax when candidates run short.
function sampleEntries(entries,count,recent) {
  if (!entries.length) return [];
  const seen = new Set(recent || []);
  let pool = entries.filter(entry => !seen.has(entry.key));
  if (pool.length < count) pool = entries.slice();
  for (let i = pool.length - 1;i > 0;i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i],pool[j]] = [pool[j],pool[i]];
  }
  return pool.slice(0,Math.min(count,pool.length));
}
// One entry per screen with a persistent per-review-day session (plugin.settings.reviewSession + saveData).
class ReviewModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.entries = [];
    this.picked = [];
    this.session = null;
    this.loading = false;
  }
  currentDay() { return reviewDay(Date.now(),this.plugin.settings.reviewResetHour); }
  async onOpen() {
    const day = this.currentDay();
    this.titleEl.setText('今日重逢 · ' + dayLabel(day));
    this.modalEl.addClass('flomo-review');
    this.loading = true;
    this.render();
    try { this.entries = await collectReviewEntries(this.plugin); }
    catch (_) { this.entries = []; }
    this.loading = false;
    this.restore(day);
    this.render();
  }
  // Restore the same-day session when every key still resolves; otherwise silently start a new batch.
  restore(day) {
    if (!this.entries.length) { this.session = null; this.picked = []; return; }
    const session = this.plugin.settings.reviewSession;
    if (session && session.date === day && Array.isArray(session.keys) && session.keys.length) {
      const byKey = new Map(this.entries.map(entry => [entry.key,entry]));
      const picked = session.keys.map(key => byKey.get(key));
      if (picked.every(entry => entry)) {
        this.session = session;
        this.picked = picked;
        return;
      }
    }
    this.newBatch(day);
  }
  newBatch(day) {
    this.picked = sampleEntries(this.entries,this.plugin.settings.reviewCount,this.plugin.settings.recentReviews);
    if (!this.picked.length) { this.session = null; return; }
    this.session = {date:day,keys:this.picked.map(entry => entry.key),index:0,done:false};
    this.plugin.settings.reviewSession = this.session;
    const recent = this.plugin.settings.recentReviews || [];
    for (const entry of this.picked) {
      const at = recent.indexOf(entry.key);
      if (at >= 0) recent.splice(at,1);
      recent.unshift(entry.key);
    }
    this.plugin.settings.recentReviews = recent.slice(0,50);
    void this.plugin.saveData(this.plugin.settings);
  }
  persist() {
    if (!this.session) return;
    this.plugin.settings.reviewSession = this.session;
    void this.plugin.saveData(this.plugin.settings);
  }
  next() {
    if (!this.picked.length) return;
    if (this.session.index >= this.picked.length - 1) this.session.done = true;
    else this.session.index += 1;
    this.persist();
    this.render();
  }
  prev() {
    if (!this.picked.length || this.session.index <= 0) return;
    this.session.index -= 1;
    this.persist();
    this.render();
  }
  again() { this.newBatch(this.currentDay()); this.render(); }
  jump(entry) { void this.plugin.app.workspace.openLinkText(`${entry.file.path}#${entry.heading}`,'',false); }
  render() {
    const el = this.contentEl;
    el.empty();
    if (this.loading) { el.createEl('p',{text:'正在读取年度记录…'}); return; }
    if (!this.entries.length) { el.createEl('p',{text:'未找到年度记录。'}); return; }
    if (this.session.done) { this.renderDone(el); return; }
    const head = el.createDiv({cls:'flomo-review-head'});
    const title = head.createDiv({cls:'flomo-review-title'});
    title.createDiv({cls:'flomo-review-title-sub',text:`今天与你重逢 ${this.session.keys.length} 条旧时光`});
    const progress = head.createDiv({cls:'flomo-review-progress'});
    const dots = progress.createDiv({cls:'flomo-review-dots'});
    for (let i = 0;i < this.picked.length;i++) dots.createSpan({cls:'flomo-review-dot' + (i <= this.session.index ? ' is-seen' : '')});
    progress.createSpan({cls:'flomo-review-count',text:`${this.session.index + 1}/${this.picked.length}`});
    this.renderCard(el,this.picked[this.session.index]);
    const nav = el.createDiv({cls:'flomo-review-nav'});
    const prevBtn = nav.createEl('button',{text:'← 上一条',cls:'flomo-review-prev'});
    prevBtn.disabled = this.session.index === 0;
    prevBtn.onclick = () => this.prev();
    const last = this.session.index >= this.picked.length - 1;
    const nextBtn = nav.createEl('button',{text:last ? '完成 ✓' : '下一条 →',cls:'flomo-review-next mod-cta'});
    nextBtn.onclick = () => this.next();
  }
  renderCard(list,entry) {
    const card = list.createDiv({cls:'flomo-review-card'});
    card.onclick = () => this.jump(entry);
    card.createDiv({cls:'flomo-review-date',text:`${entry.heading.slice(0,10)} · ${relativeDays(entry.heading)}`});
    if (entry.imagePath) {
      try {
        const image = this.plugin.app.vault.getAbstractFileByPath(entry.imagePath);
        if (image && this.plugin.app.vault.getResourcePath) card.createEl('img',{cls:'flomo-review-thumb'}).src = this.plugin.app.vault.getResourcePath(image);
      } catch (_) {}
    }
    card.createEl('p',{cls:'flomo-review-body',text:entry.text || '（无文字内容）'});
    if (entry.tags.length) {
      const tags = card.createDiv({cls:'flomo-review-tags'});
      for (const tag of entry.tags) tags.createSpan({cls:'flomo-review-tag',text:tag});
    }
    if (entry.hasAudio) card.createEl('span',{cls:'flomo-review-audio',text:'🎙 含录音'});
  }
  renderDone(el) {
    const done = el.createDiv({cls:'flomo-review-done'});
    done.createDiv({cls:'flomo-review-check',text:'✓'});
    done.createDiv({cls:'flomo-review-done-title',text:'今天的重逢，到这里'});
    done.createDiv({cls:'flomo-review-done-sub',text:`${this.session.keys.length} 条旧时光，你都翻阅过了。`});
    const hour = Math.min(23,Math.max(0,Math.round(Number(this.plugin.settings.reviewResetHour) || 0)));
    done.createDiv({cls:'flomo-review-done-sub',text:hour > 0 ? `明天 ${String(hour).padStart(2,'0')}:00 后，还有新的重逢在路上。` : '明天，还有新的重逢在路上。'});
    const nav = done.createDiv({cls:'flomo-review-nav'});
    nav.createEl('button',{text:'再来一批',cls:'flomo-review-again'}).onclick = () => this.again();
    nav.createEl('button',{text:'关闭',cls:'flomo-review-close'}).onclick = () => this.close();
  }
}
module.exports = {collectReviewEntries,sampleEntries,reviewDay,ReviewModal};
