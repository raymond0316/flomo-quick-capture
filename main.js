const {Plugin,PluginSettingTab,Setting,Notice} = require('obsidian');
const capture = require('./capture');
const {CleanupModal} = require('./cleanup');
const {DraftStore} = require('./drafts');
const {updateFlomoNoteCount} = require('./count');
const {ReviewModal} = require('./review');
const {cleanFolder} = require('./paths');
const defaults = {noteFolder:'01.快速记录/flomo-import',audioFolder:'01.快速记录/flomo-import/record',imageFolder:'01.快速记录/flomo-import/images',autoAsr:true,engine:'16k_zh',reviewCount:3,reviewRange:'all',recentReviews:[],reviewResetHour:9,reviewSession:null};
const secretName = 'raymond-flomo-tencent-asr';
module.exports = class FlomoPlugin extends Plugin {
  async onload() {
    this.settings = {...defaults,...await this.loadData()};
    for (const key of ['noteFolder','audioFolder','imageFolder']) {
      try { this.settings[key] = cleanFolder(this.settings[key]); } catch (_) { this.settings[key] = defaults[key]; }
    }
    this.drafts = new DraftStore(this.app.appId || this.app.vault.adapter?.basePath || this.app.vault.getName?.() || 'default');
    this.pending = new Map();
    this.addSettingTab(new FlomoSettings(this.app,this));
    this.addRibbonIcon('notebook-pen','Flomo 快速记录',() => this.openCapture());
    this.addCommand({id:'capture',name:'快速记录',callback:() => this.openCapture()});
    this.addCommand({id:'recover',name:'恢复未保存记录',callback:() => this.openCapture()});
    this.addCommand({id:'retry-asr',name:'补转写已有录音',callback:() => this.openCapture(true)});
    this.addCommand({id:'refresh-count',name:'重新统计所有年度笔记',callback:() => this.refreshAll()});
    this.addCommand({id:'random-review',name:'今日重逢',callback:() => this.openReview()});
    for (const event of ['modify','create','rename']) this.registerEvent(this.app.vault.on(event,file => this.schedule(file)));
    this.app.workspace.onLayoutReady(() => this.refreshAll());
  }
  isAnnual(file) {
    return file?.extension === 'md' && file.parent?.path === this.settings.noteFolder && /^\d{4}年\.md$/.test(file.name);
  }
  schedule(file) {
    if (!this.isAnnual(file)) return;
    const path = file.path;
    clearTimeout(this.pending.get(path));
    this.pending.set(path,setTimeout(async () => {
      this.pending.delete(path);
      if (!this.isAnnual(file)) return;
      try {
        const text = await this.app.vault.read(file);
        if (text !== updateFlomoNoteCount(text)) await this.app.vault.process(file,updateFlomoNoteCount);
      } catch (_) { new Notice('noteCount 更新失败，请使用重新统计命令重试。'); }
    },700));
  }
  refreshAll() { this.app.vault.getMarkdownFiles().forEach(file => this.schedule(file)); }
  async openCapture(retry=false,recovered=null) {
    if(this.cleanupBusy){new Notice('请等待附件清理完成。');return;}
    if (this.capturing) { new Notice('请先完成当前记录或转写。'); return; }
    this.capturing = true;
    try { await capture(this,retry,recovered); }
    catch (_) { new Notice('快速记录未完成，请检查文件夹配置后重试。'); }
    finally { this.capturing = false; }
  }
  openReview() { new ReviewModal(this).open(); }
  onunload() { this.captureModal?.close(); for (const timer of this.pending.values()) clearTimeout(timer); }
};
class FlomoSettings extends PluginSettingTab {
  display() {
    const el=this.containerEl; el.empty();
    const plugin=this.plugin;
    el.createEl('h2',{text:'Flomo 快速记录'});
    el.createEl('p',{text:'按年追加记录到 YYYY年.md。每个文档的 noteCount 统计其中的记录条数；保存、手动编辑和启动时自动更新。'});
    for (const [key,name] of [['noteFolder','笔记保存文件夹'],['audioFolder','录音保存文件夹'],['imageFolder','图片保存文件夹']]) {
      let draft=plugin.settings[key];
      new Setting(el).setName(name).setDesc('相对于当前 Vault 的路径；保存后对新记录生效，已有文件不会迁移。').addText(t => t.setValue(draft).onChange(v => draft=v)).addButton(b => b.setButtonText('应用').onClick(async () => {
        try { const path=cleanFolder(draft); const previous=plugin.settings[key]; plugin.settings[key]=path;
          try { await plugin.saveData(plugin.settings); } catch (error) { plugin.settings[key]=previous; throw error; }
          plugin.refreshAll(); new Notice('文件夹配置已保存。');
        } catch (error) { new Notice(error.message || '保存失败。'); }
      }));
    }
    el.createEl('h3',{text:'语音识别 · 腾讯云极速版'});
    new Setting(el).setName('保存录音后自动转写').setDesc('开启后，录音会上传到腾讯云并按账号计费；失败时保留原录音，可通过命令补转写。').addToggle(t => t.setValue(plugin.settings.autoAsr).onChange(async value => {plugin.settings.autoAsr=value; await plugin.saveData(plugin.settings);}));
    new Setting(el).setName('识别引擎').addDropdown(d => d.addOptions({'16k_zh':'中文通用（16k_zh）','16k_en':'英语（16k_en）','16k_yue':'粤语（16k_yue）'}).setValue(plugin.settings.engine).onChange(async value => {plugin.settings.engine=value; await plugin.saveData(plugin.settings);}));
    el.createEl('p',{text:'凭据使用本机 Obsidian SecretStorage，沿用原模板的配置，不写入插件 data.json。手机与电脑分别配置。'});
    let saved={};
    try { saved=JSON.parse(this.app.secretStorage?.getSecret(secretName)||'{}'); } catch (_) {}
    const draft={...saved};
    for (const [key,name] of [['appId','AppID'],['secretId','SecretId'],['secretKey','SecretKey']]) {
      new Setting(el).setName(name).addText(t => {
        t.inputEl.type=key==='appId'?'text':'password'; t.inputEl.autocomplete='off';
        t.setPlaceholder(saved[key]?'已配置；留空保持不变':'填写 '+name);
        if (key==='appId') t.setValue(saved[key]||'');
        t.onChange(value => draft[key]=value.trim()||saved[key]||'');
      });
    }
    new Setting(el).setName('保存语音识别配置').addButton(b => b.setButtonText('保存配置').setCta().onClick(() => {
      if (!/^\d+$/.test(draft.appId||'') || !/^[A-Za-z0-9]+$/.test(draft.secretId||'') || !draft.secretKey || /\s/.test(draft.secretKey)) { new Notice('请检查 AppID、SecretId 和 SecretKey 格式。'); return; }
      try {
        if (!this.app.secretStorage) throw new Error();
        this.app.secretStorage.setSecret(secretName,JSON.stringify(draft));
        new Notice('腾讯云配置已保存到本机密钥存储。'); this.display();
      } catch (_) { new Notice('密钥保存失败，请升级 Obsidian 或检查本机密钥存储。'); }
    }));
    new Setting(el).setName('补转写已有录音').setDesc('先保存上方语音识别配置，再补转写当前文件夹中尚未完成的录音；请保持应用在前台。').addButton(b => b.setButtonText('开始补转写').onClick(async () => {
      let credentials={};
      try { credentials=JSON.parse(this.app.secretStorage?.getSecret(secretName)||'{}'); } catch (_) {}
      if (!credentials.appId || !credentials.secretId || !credentials.secretKey) { new Notice('请先保存腾讯云语音识别配置。'); return; }
      b.setDisabled(true); b.setButtonText('正在补转写…');
      try { await plugin.openCapture(true); }
      finally { b.setDisabled(false); b.setButtonText('开始补转写'); }
    }));
    el.createEl('h3',{text:'今日重逢'});
    new Setting(el).setName('回顾条数').setDesc('命令「今日重逢」每次随机抽取的记录条数。').addDropdown(d => d.addOptions({'3':'3 条','4':'4 条','5':'5 条'}).setValue(String(plugin.settings.reviewCount)).onChange(async value => {plugin.settings.reviewCount=Number(value); await plugin.saveData(plugin.settings);}));
    new Setting(el).setName('回顾范围').setDesc('全部年份，或仅近一年（按记录日期过滤）。').addDropdown(d => d.addOptions({'all':'全部年份','year':'近一年'}).setValue(plugin.settings.reviewRange).onChange(async value => {plugin.settings.reviewRange=value; await plugin.saveData(plugin.settings);}));
    new Setting(el).setName('每日批次刷新时间').setDesc('到达该时刻后，下一次打开回顾生成新的一批；之前仍显示昨天的批次进度。设为 00:00 即按自然日刷新。').addDropdown(d => d.addOptions({'0':'00:00','6':'06:00','9':'09:00','12':'12:00'}).setValue(String(plugin.settings.reviewResetHour)).onChange(async value => {plugin.settings.reviewResetHour=Number(value); await plugin.saveData(plugin.settings);}));
    new Setting(el).setName('附件清理').setDesc('预览未引用附件和内容重复副本，勾选确认后移入回收站。').addButton(b => b.setButtonText('扫描与预览').onClick(() => new CleanupModal(plugin).open()));
    new Setting(el).setName('重新统计 noteCount').addButton(b => b.setButtonText('重新统计').onClick(() => plugin.refreshAll()));
  }
  constructor(app,plugin) { super(app,plugin); this.plugin=plugin; }
}
