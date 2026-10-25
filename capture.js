const obsidian = require("obsidian");
const {updateFlomoNoteCount} = require("./count");
const {attachViewport} = require("./viewport");
const {attachTagSuggestions} = require("./tags");
const {ensureFolder} = require("./paths");
module.exports = async function capture(plugin,retryOnly=false,recovered=null) {
const tp = {app:plugin.app,obsidian};
// Tencent Cloud flash ASR; credentials remain in this device's SecretStorage.
const ASR_SECRET = "raymond-flomo-tencent-asr";
const ASR_ENGINE = plugin.settings.engine;
const getSavedKey = () => {
  try { return JSON.parse(tp.app.secretStorage?.getSecret(ASR_SECRET) || "{}"); }
  catch (_) { return {}; }
};
const hasCredentials = c => Boolean(c?.appId && c?.secretId && c?.secretKey);
const asrError = error => error?.safeMessage || "网络或转写服务暂时不可用，请稍后补转写。";
const failAsr = message => Object.assign(new Error(message), {safeMessage:message});
async function prepareTencentAudio(file, data) {
  const ext = file.extension.toLowerCase();
  const direct = {wav:"wav", mp3:"mp3", m4a:"m4a", mp4:"m4a", aac:"aac", amr:"amr", ogg:"ogg-opus", opus:"ogg-opus", pcm:"pcm", silk:"silk", speex:"speex"};
  // Chromium may record Opus inside MP4. Normalize MP4/M4A as well as WebM to PCM WAV before ASR.
  if (["m4a", "mp4", "webm", "flac", "mpeg", "mpga"].includes(ext)) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AudioCtx || !OfflineCtx) throw failAsr("此录音需要转换格式；请使用 m4a、mp3 或 wav 音频再转写。");
    let ctx;
    let decoded;
    try {
      ctx = new AudioCtx();
      decoded = await ctx.decodeAudioData(data.slice(0));
    } catch (_) { throw failAsr("本机无法转换此音频，请导出为 m4a、mp3 或 wav 后重试。"); }
    finally { if (ctx) { try { await ctx.close(); } catch (_) {} } }
    if (decoded.duration > 7200) throw failAsr("音频超过 2 小时，请分段转写。");
    const length = Math.max(1, Math.ceil(decoded.duration * 16000));
    if (44 + length * 2 > 100 * 1000 * 1000) throw failAsr("格式转换后超过 100 MB，请缩短或分段转写。");
    const offline = new OfflineCtx(1, length, 16000);
    const source = offline.createBufferSource(); source.buffer = decoded;
    source.connect(offline.destination); source.start();
    const rendered = await offline.startRendering();
    const pcm = rendered.getChannelData(0);
    const wav = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(wav);
    const put = (offset, value) => { for (let i=0; i<value.length; i++) view.setUint8(offset+i,value.charCodeAt(i)); };
    put(0,"RIFF"); view.setUint32(4,36+pcm.length*2,true); put(8,"WAVE"); put(12,"fmt ");
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
    view.setUint32(24,16000,true); view.setUint32(28,32000,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
    put(36,"data"); view.setUint32(40,pcm.length*2,true);
    for (let i=0; i<pcm.length; i++) { const s=Math.max(-1,Math.min(1,pcm[i])); view.setInt16(44+i*2,s<0?s*32768:s*32767,true); }
    return {data:wav,format:"wav"};
  }
  if (!direct[ext]) throw failAsr("此音频格式暂不支持，请使用 m4a、mp3 或 wav。");
  return {data,format:direct[ext]};
}
async function transcribeFile(file, credentials) {
  if (!hasCredentials(credentials)) throw failAsr("请配置腾讯云 AppID、SecretId 和 SecretKey。");
  const raw = await tp.app.vault.readBinary(file);
  if (!raw.byteLength) throw failAsr("音频为空，请检查录音。");
  if (raw.byteLength > 100 * 1000 * 1000) throw failAsr("音频超过 100 MB，请分段后再转写。");
  const audio = await prepareTencentAudio(file,raw);
  if (!window.crypto?.subtle) throw failAsr("此版本无法进行腾讯云签名，请升级 Obsidian 后重试。");
  const params = {
    convert_num_mode:1, engine_type:ASR_ENGINE, filter_dirty:0, filter_modal:0,
    filter_punc:0, first_channel_only:1, secretid:credentials.secretId,
    speaker_diarization:0, timestamp:Math.floor(Date.now()/1000), voice_format:audio.format, word_info:0
  };
  const query = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  const hostPath = `asr.cloud.tencent.com/asr/flash/v1/${credentials.appId}?${query}`;
  const encoder = new TextEncoder();
  const hmacKey = await window.crypto.subtle.importKey("raw",encoder.encode(credentials.secretKey),{name:"HMAC",hash:"SHA-1"},false,["sign"]);
  const signature = await window.crypto.subtle.sign("HMAC",hmacKey,encoder.encode("POST"+hostPath));
  const authorization = btoa(String.fromCharCode(...new Uint8Array(signature)));
  let response;
  try {
    response = await tp.obsidian.requestUrl({url:"https://"+hostPath, method:"POST", headers:{Authorization:authorization}, contentType:"application/octet-stream", body:audio.data, throw:false});
  } catch (error) {
    // Only show an allowlisted error code, never request URLs, headers or credentials.
    const code = String(error?.message || "").match(/\bERR_[A-Z_]+\b/)?.[0];
    const hints = {
      ERR_INVALID_ARGUMENT:"请求参数被 Obsidian 拒绝，请确认手机和电脑已同步最新模板。",
      ERR_NAME_NOT_RESOLVED:"无法解析腾讯云域名，请检查网络或 DNS。",
      ERR_INTERNET_DISCONNECTED:"设备已断网，请联网后补转写。",
      ERR_CONNECTION_TIMED_OUT:"连接腾讯云超时，请检查网络后补转写。",
      ERR_CONNECTION_RESET:"与腾讯云的连接被中断，请检查网络或代理后补转写。",
      ERR_PROXY_CONNECTION_FAILED:"代理连接失败，请检查系统或 Obsidian 代理设置。",
      ERR_CERT_AUTHORITY_INVALID:"腾讯云连接的证书校验失败，请检查系统时间与网络证书。"
    };
    throw failAsr(hints[code] || (code ? `连接腾讯云失败（${code}），请稍后补转写。` : "连接腾讯云失败，请检查网络后补转写。"));
  }
  let payload;
  try { payload = response.json; } catch (_) { throw failAsr(`腾讯云返回异常（HTTP ${response.status}），请稍后重试。`); }
  const messages = {
    4001:"请求参数不正确，请检查 AppID 和音频格式。",
    4002:"鉴权失败，请检查三项配置是否属于同一账号、子账号是否获授权，以及系统时间是否准确。",
    4003:"尚未开通语音识别服务，请到腾讯云语音识别控制台开通。",
    4004:"极速版资源包已耗尽，请购买对应资源包或开通后付费。",
    4005:"腾讯云账户欠费，请充值后补转写。",
    4006:"请求并发超限，请稍后补转写。",
    4007:"音频解码失败，请换用 m4a、mp3 或 wav 格式。",
    4008:"音频上传超时，请检查网络后补转写。",
    4009:"音频上传连接断开，请保持应用在前台后重试。",
    4011:"音频过大，请分段后转写。", 4012:"音频为空，请重新录音。",
    5001:"腾讯云暂时繁忙，请稍后补转写。", 5002:"本次识别失败，请稍后补转写。", 5003:"识别超时，请稍后补转写。"
  };
  if (response.status < 200 || response.status >= 300 || payload?.code !== 0) {
    throw failAsr(messages[payload?.code] || `腾讯云转写未成功（HTTP ${response.status}，错误码 ${Number.isInteger(payload?.code)?payload.code:"未知"}）。`);
  }
  const text = Array.isArray(payload.flash_result) ? payload.flash_result.map(r => typeof r.text === "string" ? r.text.trim() : "").filter(Boolean).join("\n") : "";
  if (!text) throw failAsr("未识别到文字，请确认录音包含清晰人声。");
  return text;
}
function stripAsrMarkers(text) {
  return text.replace(/^[ \t]*(?:>[ \t]*)?<!-- flomo-asr:[^\r\n]*:(?:start|end) -->[ \t]*(?:\r?\n|$)/gm, "");
}
function asrBlock(audioPath, message) { return message.replace(/^> ?/gm, ""); }
function findAsrBlock(current, audioPath) {
  const embed = `![[${audioPath}]]`;
  const at = current.indexOf(embed);
  if (at < 0) return null;
  const start = at + embed.length;
  const tail = current.slice(start);
  const whitespace = /^\s*/.exec(tail)[0];
  const rest = tail.slice(whitespace.length);
  const status = /^(?:> )?(?:等待自动转写…|正在转写…|转写未完成：|音频格式已修复，)[^\r\n]*(?:\r?\n|$)/.exec(rest);
  const legacy = /^> \*\*语音转写\*\*/.test(rest);
  const boundary = /^(?:---[ \t]*(?:\r?\n|$)|#{1,6} |!\[\[)/.test(rest);
  return {start,end:start + (status ? whitespace.length + status[0].length : 0),complete:legacy || (!status && !boundary && Boolean(rest.trim()))};
}
async function setAsrBlock(note, audioPath, message) {
  await tp.app.vault.process(note, original => {
    const current = stripAsrMarkers(original);
    const block = findAsrBlock(current,audioPath);
    if (!block) throw failAsr("原录音链接已变更，请恢复链接后补转写；已返回的文字暂存在本机恢复缓存中。");
    // Keep text the user added while transcription was running; append the result before it.
    return current.slice(0,block.start) + "\n\n" + asrBlock(audioPath,message) + "\n\n" + current.slice(block.end).replace(/^\r?\n(?:\r?\n)*/, "");
  });
}
async function runAsrJobs(jobs, key) {
  const vault = tp.app.vault;
  let completed = 0, failed = 0;
  const active = window.__raymondFlomoAsrActive ||= new Set();
  const pending = window.__raymondFlomoAsrPending ||= (tp.app.loadLocalStorage?.("flomo-asr-pending-results") || {});
  const savePending = () => { try { tp.app.saveLocalStorage?.("flomo-asr-pending-results",pending); } catch (_) {} };
  for (const job of jobs) {
    if (active.has(job.audioPath)) continue;
    active.add(job.audioPath);
    try {
      const current = stripAsrMarkers(await vault.read(job.note));
      if (!pending[job.audioPath] && findAsrBlock(current,job.audioPath)?.complete) { completed++; continue; }
      let text = pending[job.audioPath] || "";
      if (!text.trim()) {
        const file = vault.getAbstractFileByPath(job.audioPath);
        if (!file) throw failAsr("音频尚未同步到本机，请同步完成后补转写。");
        await setAsrBlock(job.note,job.audioPath,"正在转写…请保持 Obsidian 在前台。");
        text = await transcribeFile(file,key);
        pending[job.audioPath] = text;
        savePending();
      }
      await setAsrBlock(job.note,job.audioPath,text);
      delete pending[job.audioPath]; savePending();
      completed++;
    } catch (error) {
      failed++;
      try { await setAsrBlock(job.note,job.audioPath,"转写未完成："+asrError(error)+" 可在插件设置中点「补转写已有录音」。"); } catch (_) {}
    } finally { active.delete(job.audioPath); }
  }
  new tp.obsidian.Notice(`转写完成 ${completed} 段` + (failed ? `；${failed} 段未完成，录音已保留。` : "。"),8000);
}
function showSavedRecord(target, stamp) {
  const fragment = document.createDocumentFragment();
  const label = document.createElement("span");
  label.textContent = `已保存 · ${stamp} `;
  fragment.appendChild(label);
  const view = document.createElement("button"); view.textContent = "查看记录";
  const close = document.createElement("button"); close.textContent = "关闭";
  fragment.appendChild(view); fragment.appendChild(close);
  const notice = new tp.obsidian.Notice(fragment,0);
  view.onclick = async () => {
    try {
      await tp.app.workspace.openLinkText(`${target.path}#${stamp}`,target.path,false);
      notice.hide();
    } catch (_) { new tp.obsidian.Notice("打开记录失败，请从年度文档查看。"); }
  };
  close.onclick = () => notice.hide();
}

let initialDraft = null;
if (!retryOnly && !recovered) {
  try { initialDraft = await plugin.drafts.load();
    if(plugin.recovery) initialDraft={...plugin.recovery,id:plugin.recovery.draftId}; }
  catch (_) { new tp.obsidian.Notice("草稿暂时无法读取，请稍后重试。");return; }
}
const capture = recovered || (retryOnly ? {retry:true, asr:{key:getSavedKey()}} : await new Promise((resolve) => {
  class CaptureModal extends tp.obsidian.Modal {
    constructor() { super(tp.app); this.clips = []; this.images = []; this.urls = []; this.done = false; this.busy = false; this.closed = false; this.draftId = initialDraft?.id || crypto.randomUUID(); this.draftChain = Promise.resolve(); this.draftRevision = 0; }
    onOpen() {
      this.titleEl.setText("快速记录");
      this.modalEl.addClass("flomo-capture-minimal");
      this.contentEl.addClass("flomo-content");
      const el = this.contentEl.createDiv({cls:"flomo-body"});
      this.text = el.createEl("textarea", { cls:"flomo-input", placeholder: "此刻，你想记下什么？" });
      this.disposeTags = attachTagSuggestions(tp.app,this.text);
      this.text.addEventListener("input", () => this.scheduleDraft());
      this.status = el.createEl("p", {cls:"flomo-status",attr:{"aria-live":"polite"}});
      const row = el.createDiv({cls:"flomo-tools"});
      this.record = row.createEl("button", {text: "开始录音"});
      this.record.onclick = () => this.toggleRecording();
      this.deleteRecording = row.createEl("button", {text:"删除",cls:"flomo-delete-recording"});
      this.deleteRecording.hidden = true;
      this.deleteRecording.onclick = () => {
        if(this.busy || this.saving || this.closing || this.recordingSettled===false)return;
        this.clearClips();this.status.setText("");this.scheduleDraft(true);
      };
      const gallery = row.createEl("button", {text:"添加图片"});
      for (const [button,icon] of [[this.record,"mic"],[gallery,"image"]]) {
        const glyph = button.createSpan(); tp.obsidian.setIcon(glyph,icon); button.prepend(glyph);
      }
      this.imagePicker = el.createEl("input", {type:"file"});
      this.imagePicker.accept = "image/*";
      this.imagePicker.multiple = true; this.imagePicker.style.display = "none";
      gallery.onclick = () => this.imagePicker.click();
      this.imagePicker.onchange = () => {
        for (const file of Array.from(this.imagePicker.files || [])) this.addImage(file);
        this.imagePicker.value = "";
      };
      this.imageList = el.createDiv({cls:"flomo-images"});
      this.list = el.createDiv({cls:"flomo-clips"});
      el.insertBefore(this.imageList,row); el.insertBefore(this.list,row);
      const buttons = this.contentEl.createDiv({cls:"flomo-footer"});
      const draftArea = buttons.createDiv({cls:"flomo-draft-area",attr:{"aria-live":"polite"}});
      this.draftLabel = draftArea.createSpan({cls:"flomo-draft-label"});
      this.draftRetry = draftArea.createEl("button",{text:"· 重试",cls:"flomo-draft-retry"});
      this.draftRetry.hidden = true; this.draftRetry.onclick = () => this.persistDraft();
      this.discard = draftArea.createEl("button",{text:"丢弃草稿",cls:"flomo-discard"});
      this.discard.hidden = true; this.discard.onclick = () => this.discardDraft();
      const actions = buttons.createDiv({cls:"flomo-actions"});
      actions.createEl("button", {text: "稍后继续",cls:"flomo-cancel"}).onclick = () => this.close();
      this.save = actions.createEl("button", {text: "保存记录", cls: "mod-cta"});
      this.save.onclick = async () => {
        if (this.saving || this.closed || this.closing || this.discarding) return;
        if (this.busy && (!this.recorder || this.recordingSettled !== false)) {
          this.status.setText("正在准备麦克风，请等待录音开始后再保存。"); return;
        }
        this.saving = true; this.freezeInput(true); this.save.disabled = true; this.save.setText("正在保存…");
        try {
          if (this.recorder && this.recordingSettled === false) {
            this.status.setText("正在停止录音并保存…");
            this.record.disabled = true;
            if (this.recorder.state !== "inactive") this.recorder.stop();
            const hasAudio = await this.recordingDone;
            if (this.closed) return;
            if (!hasAudio) { this.status.setText("本次没有录到声音，请重新录音后保存。"); return; }
          }
          if (!this.text.value.trim() && !this.clips.length && !this.images.length) {
            this.status.setText("请写点内容、录音或添加图片。"); return;
          }
          const asr = this.asrOptions(this.clips.length > 0);
          if (!asr) return;
          await this.persistDraft();
          this.done = true;
          resolve({text:this.text.value.trim(),clips:[...this.clips],images:[...this.images],asr,draftId:this.draftId});
          this.close();
        } catch (_) {
          this.status.setText("停止录音失败，请稍后重试保存。");
        } finally {
          this.saving = false; this.freezeInput(false);
          if (!this.closed) {
            this.save.disabled = false; this.save.setText("保存记录");
            this.updateRecordingControls();
          }
        }
      };
      this.restoring = true;
      if (initialDraft) {
        this.text.value = initialDraft.text || "";
        for (const item of initialDraft.images || []) this.addImage(item.blob,item);
        for (const item of initialDraft.clips || []) this.addClip(item.blob,item.name);
        this.setDraftStatus("✓ 草稿已恢复"); this.discard.hidden = false;
      }
      this.restoring = false;plugin.recovery=null;
      this.disposeViewport = attachViewport(this);
      this.onBackground = () => { if (document.visibilityState === "hidden" || !this.closed) void this.persistDraft(); };
      this.contentEl.ownerDocument.addEventListener("visibilitychange",this.onBackground);
      this.contentEl.ownerDocument.defaultView.addEventListener("pagehide",this.onBackground);
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        this.record.disabled = true;
        this.status.setText("此设备暂时无法录音，可以写文字或添加图片。");
      }
    }
    snapshot() { return {id:this.draftId,text:this.text.value,clips:[...this.clips],images:[...this.images]}; }
    setDraftStatus(text,error=false) {
      this.draftLabel?.setText(text);
      this.draftLabel?.classList.toggle("is-error",error);
      if(this.draftRetry) this.draftRetry.hidden = !error;
    }
    scheduleDraft(immediate=false) {
      if(this.restoring || this.done || this.closed || this.discarding) return;
      clearTimeout(this.draftTimer);this.draftRevision++;this.confirmDiscard=false;this.discard.setText("丢弃草稿");
      this.setDraftStatus("正在保存…");
      if(immediate) void this.persistDraft();
      else this.draftTimer=setTimeout(()=>this.persistDraft(),600);
    }
    persistDraft() {
      clearTimeout(this.draftTimer);
      if(this.done || this.discarding) return Promise.resolve(true);
      const snapshot = this.snapshot(), revision=this.draftRevision;
      const nonempty = Boolean(snapshot.text || snapshot.clips.length || snapshot.images.length);
      const task = this.draftChain.catch(()=>{}).then(async()=>{
        try {
          if(nonempty) await plugin.drafts.save(snapshot);
          else await plugin.drafts.clear(this.draftId);
          if(revision===this.draftRevision)this.setDraftStatus(nonempty ? "✓ 草稿已保存" : "");return true;
        } catch (_) { this.setDraftStatus("草稿未保存",true);return false; }
      });
      this.draftChain=task;return task;
    }
    async stopRecording() {
      if(this.recordingSettled === false) {
        if(this.recorder?.state !== "inactive") this.recorder.stop();
        await this.recordingDone;
      }
    }
    freezeInput(disabled) {
      this.text.readOnly=disabled;
      this.imagePicker.disabled=disabled;
      this.contentEl.querySelectorAll(".flomo-body button").forEach(button=>button.disabled=disabled);
      if(!disabled)this.updateRecordingControls();
    }
    async close() {
      if(this.done) return super.close();
      if(this.closing || this.saving || this.discarding) return;
      if(this.busy && this.recordingSettled !== false) {this.status.setText("请等待录音准备完成。");return;}
      this.closing=true;this.freezeInput(true);
      try { await this.stopRecording(); if(await this.persistDraft())super.close(); }
      finally {this.closing=false;if(!this.closed)this.freezeInput(false);}
    }
    async discardDraft() {
      if(this.saving || this.closing || this.discarding || this.busy || this.recordingSettled===false) return;
      if(!this.confirmDiscard) {this.confirmDiscard=true;this.discard.setText("确认丢弃");return;}
      this.discarding=true;clearTimeout(this.draftTimer);
      try {
        await this.draftChain;await plugin.drafts.clear(this.draftId);
        plugin.recovery=null;this.text.value="";this.clips=[];this.images=[];
        this.list.empty();this.updateRecordingControls();this.imageList.empty();this.urls.forEach(url=>URL.revokeObjectURL(url));this.urls=[];
        this.setDraftStatus("");this.discard.hidden=true;
      } catch (_) {this.setDraftStatus("草稿未丢弃",true);}
      finally {this.discarding=false;this.confirmDiscard=false;this.discard.setText("丢弃草稿");}
    }
    asrOptions(needsAudio, force = false) {
      const enabled = force || plugin.settings.autoAsr;
      const key = getSavedKey();
      if (needsAudio && enabled && !hasCredentials(key)) {
        this.status.setText("请先在插件设置中配置腾讯云，或关闭自动转写后仅保存录音。");
        return null;
      }
      return {enabled,key};
    }
    addImage(file, metadata=null) {
      if (!file.size || this.closed) return;
      const ext = /\.(jpe?g|png|gif|webp|avif|bmp|heic|heif|tiff?|svg)$/i.exec((metadata?.name || file.name))?.[1]?.toLowerCase();
      const byMime = {"image/jpeg":"jpg","image/png":"png","image/gif":"gif","image/webp":"webp","image/avif":"avif","image/heic":"heic","image/heif":"heif","image/bmp":"bmp","image/svg+xml":"svg","image/tiff":"tiff"};
      const extension = metadata?.ext || byMime[file.type] || ext;
      if (!extension) { this.status.setText("无法识别图片格式，请选择 JPG、PNG 或其他常见图片。"); return; }
      const item = {blob:file,name:metadata?.name || file.name || "图片",ext:extension}; this.images.push(item);
      const row = this.imageList.createDiv();
      const image = row.createEl("img", {alt:metadata?.name || file.name || "待保存图片"});
      Object.assign(image.style,{maxWidth:"100%",maxHeight:"180px",objectFit:"contain",display:"block"});
      const url = URL.createObjectURL(file); this.urls.push(url); image.src = url;
      row.createEl("button",{text:"移除图片"}).onclick = () => {
        this.images = this.images.filter(x => x !== item); row.remove(); URL.revokeObjectURL(url); this.scheduleDraft(true);
      };
      this.scheduleDraft(true);
    }
    updateRecordingControls() {
      if(!this.record)return;
      const active=this.recordingSettled===false;
      this.record.setText(active ? "停止录音" : this.clips.length ? "重录" : "开始录音");
      const glyph=this.record.createSpan();tp.obsidian.setIcon(glyph,active?"square":this.clips.length?"rotate-ccw":"mic");this.record.prepend(glyph);
      this.record.disabled=this.busy || this.saving || this.closing || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder==="undefined";
      this.deleteRecording.hidden=active || !this.clips.length;
      this.deleteRecording.disabled=this.busy || this.saving || this.closing;
    }
    clearClips() {
      this.list.querySelectorAll("audio").forEach(audio=>audio.pause());this.list.empty();this.clips=[];
      for(const url of this.clipUrls || []) {URL.revokeObjectURL(url);this.urls=this.urls.filter(item=>item!==url);}
      this.clipUrls=new Set();this.updateRecordingControls();
    }
    addClip(blob, name) {
      if (!blob.size || this.closed) return;
      this.clips.push({blob,name});
      const row = this.list.createDiv(); row.createEl("p", {text: name});
      const audio = row.createEl("audio"); audio.controls = true;
      const url = URL.createObjectURL(blob); this.urls.push(url);(this.clipUrls ||= new Set()).add(url);audio.src = url;
      this.updateRecordingControls();this.scheduleDraft(true);
    }
    async toggleRecording() {
      if (this.busy || this.saving || this.closing) return;
      if (this.recorder?.state === "recording") {
        this.busy = true; this.record.disabled = true; this.status.setText("正在整理录音…");
        this.recorder.stop(); return;
      }
      this.busy = true; this.updateRecordingControls();
      try {
        this.status.setText("正在请求麦克风权限…");
        const stream = await navigator.mediaDevices.getUserMedia({audio: true});
        if (this.closed) { stream.getTracks().forEach(t => t.stop()); return; }
        this.stream = stream;
        const type = ["audio/mp4;codecs=mp4a.40.2", "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"]
          .find(t => MediaRecorder.isTypeSupported(t));
        const rec = new MediaRecorder(stream, type ? {mimeType: type} : undefined);
        this.recorder = rec;
        this.recordingSettled = false;this.recordingError=false;
        this.recordingDone = new Promise(resolve => { this.finishRecording = resolve; });
        const chunks = [];
        rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        rec.onerror = () => {
          this.recordingError = true;
          this.status.setText("录音中断，请检查试听，必要时重新录音。");
          if (rec.state !== "inactive") rec.stop();
          stream.getTracks().forEach(t => t.stop());
          this.busy = false; this.updateRecordingControls();
          if (!this.saving) this.save.setText("保存记录");
        };
        rec.onstop = () => {
          stream.getTracks().forEach(t => t.stop()); clearInterval(this.timer);
          const blob = new Blob(chunks, {type: rec.mimeType || type || "audio/webm"});
          const successful=blob.size>0 && !this.recordingError;
          this.recordingSettled = true;
          if(successful) {this.clearClips();this.addClip(blob,"录音 "+window.moment().format("HH:mm:ss"));}
          this.busy = false; this.updateRecordingControls();
          if (!this.saving) this.save.setText("保存记录");
          if (!this.closed && !this.saving) this.status.setText(successful ? "" : this.clips.length ? "重录未完成，原录音已保留。" : "没有录到声音，请重试。");
          this.recordingSettled = true;
          this.finishRecording?.(successful);
        };
        rec.start(1000); this.busy = false; this.record.disabled = false;
        this.updateRecordingControls(); this.save.setText("结束并保存"); this.started = Date.now();
        this.status.setText("正在录音 00:00 · 请保持应用在前台");
        this.timer = setInterval(() => {
          const seconds = Math.floor((Date.now() - this.started) / 1000);
          this.status.setText(`正在录音 ${String(Math.floor(seconds/60)).padStart(2,"0")}:${String(seconds%60).padStart(2,"0")} · 请保持应用在前台`);
        }, 1000);
      } catch (error) {
        this.recordingSettled = true; this.finishRecording?.(false);
        this.stream?.getTracks().forEach(t => t.stop());
        this.busy = false; this.updateRecordingControls();
        this.status.setText("无法使用麦克风，请检查系统权限后重试。");
        console.error(error);
      }
    }
    onClose() {
      clearTimeout(this.draftTimer);
      if(!this.done && !this.discarding) void this.persistDraft();
      this.disposeViewport?.();
      this.contentEl.ownerDocument.removeEventListener("visibilitychange",this.onBackground);
      this.contentEl.ownerDocument.defaultView.removeEventListener("pagehide",this.onBackground);
      this.disposeTags?.();
      this.closed = true; clearInterval(this.timer);
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
      this.stream?.getTracks().forEach(t => t.stop());
      this.contentEl.querySelectorAll("audio").forEach(a => a.pause());
      this.urls.forEach(url => URL.revokeObjectURL(url));
      this.contentEl.empty();
      if (!this.done) resolve(null);
    }
  }
  const modal = new CaptureModal(); plugin.captureModal = modal; modal.open();
}));
const input = capture?.text || "";
if (capture?.retry) {
  await (async () => {
    try {
      const jobs = [];
      for (const note of tp.app.vault.getMarkdownFiles().filter(f => plugin.isAnnual(f))) {
        const text = await tp.app.vault.read(note);
        const matches = [...text.matchAll(/!\[\[([^\]|]+)\]\]/g)].filter(m => m[1].startsWith(plugin.settings.audioFolder + "/"));
        for (const match of matches) {
          const audioPath = match[1];
          if (findAsrBlock(stripAsrMarkers(text),audioPath)?.complete && !(window.__raymondFlomoAsrPending || tp.app.loadLocalStorage?.("flomo-asr-pending-results") || {})[audioPath]) continue;
          if (!jobs.some(j => j.note.path === note.path && j.audioPath === audioPath)) jobs.push({note,audioPath});
        }
      }
      if (!jobs.length) { new tp.obsidian.Notice("没有需要补转写的 record 录音。"); return; }
      new tp.obsidian.Notice(`开始补转写 ${jobs.length} 段录音，请保持应用在前台。`);
      await runAsrJobs(jobs,capture.asr.key);
    } catch (_) { new tp.obsidian.Notice("补转写未完成，请稍后重试；已有录音保留。"); }
  })();
} else if (capture) {
  const capturedAt = window.moment();
  const year = capturedAt.format("YYYY");
  const stamp = capturedAt.format("YYYY-MM-DD HH:mm:ss");
  const folder = plugin.settings.noteFolder;

  const path = `${folder}/${year}年.md`;
  let entry = "";
  const savedAudio = [];
  const savedImages = [];
  const audioPaths = [];
  await (async () => {
    try {
      const vault = tp.app.vault;
      await ensureFolder(vault,folder);
      const audioFolder = plugin.settings.audioFolder;
      if (capture.clips.length && !vault.getAbstractFileByPath(audioFolder)) {
        try { await ensureFolder(vault,audioFolder); }
        catch (error) { if (!vault.getAbstractFileByPath(audioFolder)) throw error; }
      }
      for (const [i, clip] of capture.clips.entries()) {
        const mime = clip.blob.type.toLowerCase();
        const fromName = /\.(m4a|mp3|wav|ogg|webm|mp4|aac|flac|opus)$/i.exec(clip.name)?.[1];
        const ext = fromName || (mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : mime.includes("mpeg") ? "mp3" : mime.includes("wav") ? "wav" : "webm");
        const unique = window.crypto.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const audioPath = `${audioFolder}/recording-${capturedAt.format("YYYYMMDD-HHmmss")}-${unique}-${i + 1}.${ext}`;
        await vault.createBinary(audioPath, await clip.blob.arrayBuffer());
        audioPaths.push(audioPath);
        savedAudio.push(`![[${audioPath}]]` + (capture.asr.enabled ? "\n\n" + asrBlock(audioPath, "> 等待自动转写…") : ""));
      }
      const imageFolder = plugin.settings.imageFolder;
      if (capture.images.length && !vault.getAbstractFileByPath(imageFolder)) {
        try { await ensureFolder(vault,imageFolder); }
        catch (error) { if (!vault.getAbstractFileByPath(imageFolder)) throw error; }
      }
      for (const [i,image] of capture.images.entries()) {
        const id = window.crypto.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const imagePath = `${imageFolder}/image-${capturedAt.format("YYYYMMDD-HHmmss")}-${id}-${i+1}.${image.ext}`;
        await vault.createBinary(imagePath,await image.blob.arrayBuffer());
        savedImages.push(`![[${imagePath}]]`);
      }
      entry = `\n\n## ${stamp}\n\n${[input,...savedImages,...savedAudio].filter(Boolean).join("\n\n")}\n\n---\n`;
      let target = vault.getAbstractFileByPath(path);
      if (!target) {
        try {
          target = await vault.create(path, `# ${year} 年随手记录\n\n共 0 条，按记录时间排列。\n`);
        } catch (error) {
          target = vault.getAbstractFileByPath(path);
          if (!target) throw error;
        }
      }
      let count = 0;
      await vault.process(target, (current) => {
        const updated = current.trimEnd() + entry;
        const result = updateFlomoNoteCount(updated);
        count = Number(result.match(/^noteCount: (\d+)/m)?.[1] || 0);
        return result.replace(/^共 \d+ 条[^\n]*$/m, `共 ${count} 条，按记录时间排列。`);
      });
      plugin.recovery = null;
      try { await plugin.drafts.clear(capture.draftId); }
      catch (_) { new tp.obsidian.Notice("记录已保存，草稿清理失败。"); }
      showSavedRecord(target,stamp);
      const index = vault.getAbstractFileByPath(`${folder}/00-时间索引.md`);
      if (index) {
        try {
          await vault.process(index, (current) => {
            const line = `- [[${year}年]]：${count} 条`;
            const pattern = new RegExp(`^- \\[\\[${year}年\\]\\]：.*$`, "m");
            return pattern.test(current) ? current.replace(pattern, line) : current.trimEnd() + "\n" + line + "\n";
          });
        } catch (error) {
          console.error(error);
          new tp.obsidian.Notice("记录已保存，但索引更新失败。");
        }
      }
      if (capture.asr.enabled && audioPaths.length) {
        try { await runAsrJobs(audioPaths.map(audioPath => ({note:target,audioPath})),capture.asr.key); }
        catch (_) { new tp.obsidian.Notice("记录和录音已保存；转写未完成，可稍后补转写。"); }
      }
    } catch (error) {
      plugin.recovery = capture;
      new tp.obsidian.Notice("记录保存失败，请重新打开快速记录恢复草稿。", 10000);

    }
  })();
}

};
