// 多框筛选只作用于已加载的 Bitsearch API 结果；保留 dht 的同框与同文件路径语义。
const $ = id => document.getElementById(id);
const fields = ["name-include", "name-exclude", "file-include", "file-exclude"];
const units = {KB:1000, MB:1000**2, GB:1000**3, TB:1000**4};
const normalize = value => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[._\-+]/g," ").trim().replace(/\s+/gu," ");
const words = value => normalize(value).split(" ").filter(Boolean);
const allWords = (text, value) => words(value).every(word => normalize(text).includes(word));
const localKeys = [...fields,"size-min","size-min-unit","size-max","size-max-unit","date-min","date-max","local-page-size"];
const initial = () => ({...Object.fromEntries(fields.map(key=>[key,""])), "size-min":"", "size-min-unit":"GB", "size-max":"", "size-max-unit":"GB", "date-min":"", "date-max":"", "local-page-size":"-1"});
// 浏览器内存缓存与本机代理采用同一小时期限；重开页面由代理磁盘缓存接续。
const cacheTtlMs = 60 * 60 * 1000;
class TimedMap extends Map {
  constructor(){super();this.expires=new Map();}
  set(key,value){super.set(key,value);this.expires.set(key,Date.now()+cacheTtlMs);return this;}
  has(key){if(this.expires.get(key)<=Date.now()){this.delete(key);return false;}return super.has(key);}
  get(key){return this.has(key)?super.get(key):undefined;}
  delete(key){this.expires.delete(key);return super.delete(key);}
  clear(){this.expires.clear();super.clear();}
}
let filters = initial(), rows = [], pageSourceCount = 0, details = new TimedMap(), detailRequests = new Map(), detailErrors = new Map(), detailSources = new Map(), torrentFiles = new TimedMap(), torrentRequests = new Map(), fileSizeNotices = new Map(), fileSizeLoading = new Set(), searchSequence = 0, loadedPage = 0, hasNext = false, hasPrev = false, sourceSeed = "", loadedQueryKey = "", pendingQueryKey = "", localState = null, initialCategory = "", initialSubcategory = "", categoryTree = [], rateLimit = {};
const pageCache = new Map(), pageRequests = new Map(), pageCacheTtlMs = cacheTtlMs, pageCacheLimit = 50;
const rateStorageKey="bitsearch-api-rate-v1";
function storedRate(){try{const value=JSON.parse(localStorage.getItem(rateStorageKey)||"null");return value&&Date.parse(value.reset)>Date.now()?value:{};}catch{return {};}}
rateLimit=storedRate();
const rateChannel=typeof BroadcastChannel==="function"?new BroadcastChannel("bitsearch-api-rate"):null;
function status(message, kind="") { $("status").textContent=message; $("status").className=kind; }
function error(message) { $("error").textContent=message; $("error").hidden=!message; }
function sizeBytes(value, unit) { if (!String(value).trim()) return null; const n=Number(value); if (!Number.isFinite(n)||n<0) throw Error("大小必须是非负数字"); const bytes=n*units[unit]; if (!Number.isSafeInteger(bytes)) throw Error("大小超出支持范围或包含过多小数位"); return bytes; }
function readForm() {
  const next={}; for(const key of localKeys) next[key]=$(key).value.trim();
  const min=sizeBytes(next["size-min"],next["size-min-unit"]), max=sizeBytes(next["size-max"],next["size-max-unit"]);
  if(min!==null&&max!==null&&min>max) throw Error("最小总大小不能大于最大总大小");
  if(next["date-min"]&&next["date-max"]&&next["date-min"]>next["date-max"]) throw Error("最早 API 日期不能晚于最晚 API 日期");
  const target=Number(next["local-page-size"]);
  if(!Number.isInteger(target)||(target!==-1&&(target<1||target>1000)))throw Error("本地每页目标条数必须是 -1 或 1–1000 的整数");
  next["local-page-size"]=String(target);
  return next;
}
function fill() { for(const key of localKeys) $(key).value=filters[key];$("local-fill-enabled").checked=Number(filters["local-page-size"])>0;$("local-scope").textContent=$("local-fill-enabled").checked?"本地页自动补齐":"当前 API 页";updateClearButtons(); }
// 本地条件在筛选框底部显示可移除标签；API 设置直接通过表单展示。
function addChip(root,label,onRemove) { const chip=document.createElement("button");chip.type="button";chip.className="secondary";chip.textContent=`${label} ×`;chip.onclick=onRemove;root.append(chip); }
function chips() {
  const filters=Object.fromEntries(localKeys.map(key=>[key,$(key).value]));
  const localRoot=$("local-filter-chips");localRoot.replaceChildren();const labels={"name-include":"名称包含","name-exclude":"名称排除","file-include":"文件路径包含","file-exclude":"文件路径排除","size-min":"最小总大小","size-max":"最大总大小","date-min":"最早日期","date-max":"最晚日期"};
  const keys=[...fields,"size-min","size-max","date-min","date-max"];
  for(const key of keys) if(filters[key]) { const value=key.startsWith("size-")?`${filters[key]} ${filters[key+"-unit"]}`:filters[key];addChip(localRoot,`${labels[key]} ${value}`,()=>{ $(key).value=""; commit(); }); }
  if(Number(filters["local-page-size"])>0)addChip(localRoot,`本地每页补齐 ${filters["local-page-size"]} 条`,()=>{$("local-page-size").value="-1";commit();});
  const params=new URLSearchParams(); for(const key of localKeys) if(filters[key]&&(key!=="local-page-size"||filters[key]!=="-1")) params.set(key,filters[key]);for(const key of ["category","subcategory","sort","order","limit"])if($(key).value)params.set(key,$(key).value);history.replaceState(null,"","?"+params);
}
function match(row, detail, ignorePath=false) {
  if(!allWords(displayTitle(row,detail),filters["name-include"])) return false;
  if(words(filters["name-exclude"]).some(word=>normalize(displayTitle(row,detail)).includes(word))) return false;
  if(!ignorePath&&filters["file-include"]&&!(detail?.files||[]).some(file=>allWords(file.path||file,filters["file-include"]))) return false;
  if(!ignorePath&&filters["file-exclude"]&&(detail?.files||[]).some(file=>allWords(file.path||file,filters["file-exclude"]))) return false;
  const min=sizeBytes(filters["size-min"],filters["size-min-unit"]),max=sizeBytes(filters["size-max"],filters["size-max-unit"]);
  if(min!==null&&(row.size==null||row.size<min)) return false;
  if(max!==null&&(row.size==null||row.size>max)) return false;
  const date=rowDate(row,detail);
  if(filters["date-min"]&&(!date||date<filters["date-min"])) return false;
  if(filters["date-max"]&&(!date||date>filters["date-max"])) return false;
  return true;
}
// 文件路径只存在于详情；详情缺失时保留候选，避免把未知当成不匹配。
function needsPathDetail(){return Boolean(filters["file-include"]||filters["file-exclude"]);}
function infohashOf(row){return String(details.get(row.id)?.infohash||row.infohash||"").toUpperCase();}
function filesFor(row){const apiFiles=details.get(row.id)?.files,metadata=torrentFiles.get(infohashOf(row));return metadata?mergeFileSizes(apiFiles||[],metadata).files:apiFiles||null;}
function resultDetail(row){const api=details.get(row.id),files=filesFor(row);return files?{...api,files}:api;}
function matchAvailable(row){const detail=resultDetail(row);return needsPathDetail()&&!detail?.files?match(row,detail,true):match(row,detail);}
function pendingPathCount(list){return needsPathDetail()?list.filter(row=>!resultDetail(row)?.files).length:0;}
function canMatchSize(row){const min=sizeBytes(filters["size-min"],filters["size-min-unit"]),max=sizeBytes(filters["size-max"],filters["size-max-unit"]);return (min===null||(row.size!=null&&row.size>=min))&&(max===null||(row.size!=null&&row.size<=max));}
async function getDetail(row) {
  if(details.has(row.id))return details.get(row.id);
  if(detailRequests.has(row.id))return detailRequests.get(row.id);
  const request=(async()=>{const response=await fetch("/api/detail?id="+encodeURIComponent(row.id)),data=await response.json();acceptRate(data.rate_limit);detailSources.set(row.id,data.cached===true?"cache":"api");if(!response.ok)throw Error(data.error||"详情读取失败");const detail=data.torrent;details.set(row.id,detail);detailErrors.delete(row.id);return detail;})();
  detailRequests.set(row.id,request);
  try{return await request;}finally{detailRequests.delete(row.id);}
}
function link(label,href) { const a=document.createElement("a"); a.textContent=label; a.href=href; a.target="_blank"; a.rel="noopener noreferrer"; return a; }
function fact(label,value) { const node=document.createElement("div"),dt=document.createElement("dt"),dd=document.createElement("dd"); dt.textContent=label;dd.textContent=value;node.append(dt,dd);return node; }
function gbBytes(value) { return value!=null&&value!==""&&Number.isFinite(Number(value)) ? (Number(value)/1e9).toFixed(1)+" GB" : "API 未提供"; }
function displayTitle(row,detail) { const raw=detail?.title||row.title||"无标题";if(!raw.includes("�"))return raw;try { const dn=new URLSearchParams((detail?.magnetUri||"").split("?")[1]).get("dn");return dn||raw; } catch { return raw; } }
function magnetFromInfohash(row){const hash=String(row.infohash||"").trim();return /^[0-9a-f]{40}$/i.test(hash)?`magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=${encodeURIComponent(row.title||"")}`:"";}
function categoryName(row) { const category=categoryTree.find(item=>String(item.id)===String(row.category));const sub=category?.subCategories?.find(item=>String(item.id)===String(row.subCategory));return [category?.name||row.category||"未分类",sub?.name].filter(Boolean).join(" / "); }
function highlight(root,value) { const strong=document.createElement("strong");strong.textContent=value;root.append(strong); }
function showRate() { const root=$("api-meta"),reset=String(rateLimit.reset||"未知").replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}).*$/,"$1 $2");root.replaceChildren();if(!rateLimit.limit){root.textContent="API 额度：暂未取得";return;}root.append("API 额度：剩余 ");highlight(root,`${rateLimit.remaining??"?"} / ${rateLimit.limit}`);if(rateLimit.tier){root.append("（");highlight(root,rateLimit.tier);root.append("）");}root.append("；重置 ");highlight(root,reset); }
// 同一重置周期额度只能下降；刷新页面时从本地存储恢复已知值。
function acceptRate(observed,share=true){
  if(!observed||!Object.keys(observed).length){if(!rateLimit.limit)showRate();return;}
  const next={...rateLimit,...observed},previousReset=Date.parse(rateLimit.reset||""),nextReset=Date.parse(next.reset||"");
  const samePeriod=Number.isFinite(previousReset)&&Number.isFinite(nextReset)&&nextReset===previousReset;
  if(Number.isFinite(previousReset)&&Number.isFinite(nextReset)&&nextReset<previousReset)return;
  if(samePeriod&&Number.isFinite(Number(rateLimit.remaining))&&Number(next.remaining)>Number(rateLimit.remaining))return;
  if(JSON.stringify(next)===JSON.stringify(rateLimit))return;
  rateLimit=next;showRate();try{localStorage.setItem(rateStorageKey,JSON.stringify(next));}catch{}if(share)rateChannel?.postMessage({rate:next});
}
if(rateChannel)rateChannel.onmessage=event=>acceptRate(event.data?.rate,false);
function showPaging(paging) { const root=$("site-total");root.replaceChildren();for(const [label,value,suffix] of [["结果总数：本地筛选前 ",`${paging.total??"未知"} 条`,""],["当前第 ",`${loadedPage} / ${paging.totalPages??"?"}`," 页"]]){const item=document.createElement("span");item.className="result-metric";item.append(label);highlight(item,value);item.append(suffix);root.append(item);}}
function showLocalPaging(page,index){const root=$("site-total"),range=page.startApiPage===page.endApiPage?`${page.startApiPage}`:`${page.startApiPage}–${page.endApiPage}`;root.replaceChildren();for(const [label,value,suffix] of [["结果总数：本地筛选前 ",`${page.paging.total??"未知"} 条`,""],["当前第 ",`${index} / ${localState.exhausted?localState.pages.length:"?"}`," 页"],["本地每页目标 ",`${filters["local-page-size"]} 条`,""],["来源 API 页 第 ",range," 页"]]){const item=document.createElement("span");item.className="result-metric";item.append(label);highlight(item,value);item.append(suffix);root.append(item);}}
function listSection(card,title,items,asLinks=false) { const heading=document.createElement("h4");heading.textContent=`${title} · ${items.length}`;card.append(heading);const list=document.createElement("ul");list.className="metadata-file-tree";for(const item of items){const li=document.createElement("li");li.className="metadata-file-node";if(asLinks)li.append(link(item.title,item.url));else li.textContent=item;list.append(li);}if(!items.length)list.textContent="站点未提供";card.append(list); }
// 文件路径按目录分层；同一完整路径只创建一个文件节点，公共目录只显示一次。
function fileTree(files) {
  const root={folders:new Map(),files:new Map()};let count=0;
  for(const file of files){const raw=typeof file==="string"?file:file?.path||file?.name||"";const parts=String(raw).replaceAll("\\","/").split("/").filter(Boolean);if(!parts.length)continue;const name=parts.pop();let branch=root;for(const part of parts){if(!branch.folders.has(part))branch.folders.set(part,{folders:new Map(),files:new Map()});branch=branch.folders.get(part);}if(branch.files.has(name))continue;branch.files.set(name,typeof file==="string"?null:file?.size??null);count++;}
  summarizeFileTree(root);
  return {root,count};
}
const fileTreeOpen=new Map();
const fileListSort=new Map(),fileListFolders=new Map();
// 表格共用列宽，按同级条目排序；目录开合与排序在卡片重绘后仍保留。
function fileSection(card,files) {
  const {root,count}=fileTree(files),section=document.createElement("section"),heading=document.createElement("h4"),header=document.createElement("div"),id=card.dataset.id;
  section.className="file-preview";
  header.className="file-preview-header";
  heading.textContent=`文件路径 · ${count}`;
  header.append(heading);
  if(root.folders.size){const actions=document.createElement("div");actions.className="file-tree-actions";for(const [label,open] of [["全部折叠",false],["全部展开",true]]){const button=document.createElement("button");button.type="button";button.className="secondary";button.textContent=label;button.onclick=()=>{fileTreeOpen.set(id,open);fileListFolders.delete(id);drawRows();};actions.append(button);}header.append(actions);}
  section.append(header);
  if(count){
    const viewport=document.createElement("div"),table=document.createElement("table"),head=document.createElement("thead"),headRow=document.createElement("tr"),body=document.createElement("tbody");viewport.className="file-list-viewport";table.className="file-list";
    const columns=[["name","名称"],["size","大小"],["count","数量"]];
    for(const [key,label] of columns){const cell=document.createElement("th"),button=document.createElement("button");cell.scope="col";button.type="button";button.onclick=()=>{const previous=fileListSort.get(id);fileListSort.set(id,{key,direction:previous?.key===key&&previous.direction==="desc"?"asc":"desc"});drawRows();};cell.append(button);headRow.append(cell);}
    head.append(headRow);table.append(head,body);viewport.append(table);section.append(viewport);
    function drawRows(){
      const sort=fileListSort.get(id)||{key:"name",direction:"asc"};
      for(let i=0;i<columns.length;i++){const [key,label]=columns[i],cell=headRow.children[i],active=sort.key===key;cell.setAttribute("aria-sort",active?sort.direction==="desc"?"descending":"ascending":"none");cell.firstChild.textContent=label+(active?sort.direction==="desc"?" ↓":" ↑":"");}
      body.replaceChildren();const folderStates=fileListFolders.get(id)||new Map();
      function appendRows(branch,depth,path){for(const entry of sortedFileEntries(branch,sort.key,sort.direction)){
        const row=document.createElement("tr"),nameCell=document.createElement("td"),sizeCell=document.createElement("td"),countCell=document.createElement("td");row.className=entry.folder?"file-list-folder":"file-list-file";nameCell.className="file-list-name";nameCell.style.paddingLeft=`${8+Math.min(depth,3)*10}px`;sizeCell.className="file-list-size";countCell.className="file-list-count";
        if(entry.folder){const folderPath=[...path,entry.name],folderKey=JSON.stringify(folderPath),open=folderStates.get(folderKey)??fileTreeOpen.get(id)??true,toggle=document.createElement("button");toggle.type="button";toggle.className="file-folder-toggle";toggle.textContent=`${open?"▾":"▸"} ${entry.name}`;toggle.title=entry.name;toggle.setAttribute("aria-expanded",String(open));toggle.onclick=()=>{folderStates.set(folderKey,!open);fileListFolders.set(id,folderStates);drawRows();};nameCell.append(toggle);}else{const label=document.createElement("span");label.className="file-name-label";label.textContent=entry.name;label.title=entry.name;nameCell.append(label);}
        sizeCell.textContent=entry.bytes==null?"未知大小":gbBytes(entry.bytes);countCell.textContent=entry.folder?String(entry.count):"";row.append(nameCell,sizeCell,countCell);body.append(row);
        if(entry.folder&&(folderStates.get(JSON.stringify([...path,entry.name]))??fileTreeOpen.get(id)??true))appendRows(entry.child,depth+1,[...path,entry.name]);
      }}
      appendRows(root,0,[]);
    }
    drawRows();
  }else{const empty=document.createElement("p");empty.className="muted";empty.textContent="站点未提供";section.append(empty);}
  card.append(section);
}
function currentRows() { return uniqueTorrents(rows.filter(row=>matchAvailable(row))); }
function renderCurrent() { const list=currentRows();render(list);if(localState?.current){const page=localState.pages[localState.current-1],pending=pendingPathCount(list);$("count").textContent=`本地第 ${localState.current} 页显示 ${list.length} 条${pending?` · ${pending} 条文件路径待核实`:""}${page.exhausted&&list.length<localTarget()?"（API 结果已用尽）":""}`;}else $("count").textContent=`本页：本地筛选前 ${pageSourceCount} 条 / 本地筛选后 ${list.length} 条`;syncBatchButtons(list); }
function needsTorrent(row){const hash=infohashOf(row),files=filesFor(row);return /^[0-9A-F]{40}$/.test(hash)&&!torrentFiles.has(hash)&&(!files?.length||files.some(file=>file.size==null));}
function syncBatchButtons(list=currentRows()){const detailCount=list.filter(row=>!details.has(row.id)).length,sizeCount=list.filter(needsTorrent).length,needsVerification=Boolean(localState?.current&&needsPathDetail()&&localState.verifyThrough<localState.current&&pendingPathCount(list));$("bulk-detail-label").textContent=needsVerification?"批量获取详情并补齐本地页":`批量获取当前页详情${detailCount?`（${detailCount}）`:""}`;$("bulk-file-sizes-label").textContent=`批量补齐当前页文件大小${sizeCount?`（${sizeCount}）`:""}`;}
async function getTorrentFiles(row){
  const hash=infohashOf(row);if(torrentFiles.has(hash))return torrentFiles.get(hash);
  if(!torrentRequests.has(hash)){
    const request=(async()=>{const response=await fetch("/api/torrent-file-sizes?infohash="+encodeURIComponent(hash)),data=await response.json();if(!response.ok)throw Error(data.error||"Torrent 元数据读取失败");if(!Array.isArray(data.files)||!data.files.length)throw Error("Torrent 元数据没有文件列表");torrentFiles.set(hash,data.files);return data.files;})();
    torrentRequests.set(hash,request);
  }
  try{return await torrentRequests.get(hash);}finally{torrentRequests.delete(hash);}
}
async function enrichFileSizes(row) {
  const id=row.id;if(!needsTorrent(row)||fileSizeLoading.has(id))return false;
  fileSizeLoading.add(id);fileSizeNotices.delete(id);renderCurrent();
  try {
    const files=await getTorrentFiles(row);
    const apiFiles=details.get(id)?.files||[],merged=mergeFileSizes(apiFiles,files);
    const difference=apiFiles.length&&merged.unmatchedApi?`；${merged.unmatchedApi} 条 API 路径未对应，已以 Torrent 路径为准`:"";
    fileSizeNotices.set(id,{message:`Torrent 已补齐 ${merged.files.length} 个文件大小${difference}`,error:false});return true;
  } catch(e) { fileSizeNotices.set(id,{message:`Torrent 补齐失败：${e.message}`,error:true});return false; }
  finally {fileSizeLoading.delete(id);renderCurrent();}
}
function render(list, pending=0) {
  const root=$("results"),expanded=new Set([...root.querySelectorAll("article[data-id] .card-more[open]")].map(node=>node.closest("article").dataset.id));root.replaceChildren();for(const row of list) {
    const card=document.createElement("article");const torrentState=torrentFiles.has(infohashOf(row))?" torrent-complete":fileSizeNotices.get(row.id)?.error?" torrent-failed":"";card.className="result metadata-stream-card"+torrentState;card.dataset.id=row.id;card.tabIndex=0;
    const d=details.get(row.id),files=filesFor(row),failure=detailErrors.get(row.id);const header=document.createElement("div");header.className="metadata-card-header";const title=document.createElement("div");title.className="metadata-card-title";const heading=document.createElement("h3");heading.textContent=displayTitle(row,d);heading.title=heading.textContent;title.append(heading);const badge=document.createElement("span");badge.className="card-badge";badge.textContent=[categoryName(row),row.verified?"已验证":"未验证"].join(" · ");header.append(title,badge);if(torrentFiles.has(infohashOf(row))){const success=document.createElement("span");success.className="torrent-success-badge";success.textContent="✓ 文件大小已补齐";header.append(success);}card.append(header);
    if(d&&displayTitle(row,d)!==d.title){const note=document.createElement("p");note.className="muted";note.textContent="API title 原值："+d.title+"；显示标题取自 API Magnet 名称。";card.append(note);}
    const sizeFacts=document.createElement("dl"),activityFacts=document.createElement("dl");sizeFacts.className="metadata-card-facts size-facts";activityFacts.className="metadata-card-facts activity-facts";for(const [label,value] of [["总大小",gbBytes(d?.size??row.size)],["文件数",files?fileTree(files).count:"待补充"]])sizeFacts.append(fact(label,String(value)));for(const [label,value] of [["做种数",d?.swarm?.seeders??row.seeders??"未提供"],["下载人数",d?.swarm?.leechers??row.leechers??"未提供"],["下载次数",d?.downloads??row.downloads??"未提供"]])activityFacts.append(fact(label,String(value)));card.append(sizeFacts,activityFacts);
    if(failure){const warning=document.createElement("p");warning.className="detail-error";warning.textContent="详情未取得："+failure;card.append(warning);}
    const links=document.createElement("div");links.className="card-actions";links.append(link("Bitsearch 页面",`https://bitsearch.eu/torrent/${row.id}`));const magnet=d?.magnetUri||magnetFromInfohash(row);if(magnet){links.append(link("使用默认下载器下载",magnet));const copy=document.createElement("button");copy.type="button";copy.className="secondary";copy.textContent="复制 Magnet";copy.onclick=async()=>{try{await navigator.clipboard.writeText(magnet);copy.textContent="已复制";}catch{copy.textContent="复制失败";}};links.append(copy);}card.append(links);const notice=fileSizeNotices.get(row.id);if(notice){const message=document.createElement("p");message.className=notice.error?"detail-error":"torrent-success-notice";message.textContent=notice.message;card.append(message);}
    const more=document.createElement("details"),summary=document.createElement("summary"),identity=document.createElement("p"),extraFacts=document.createElement("dl");more.className="card-more";more.open=expanded.has(row.id);summary.textContent="更多 API 信息";identity.className="mono muted";identity.textContent=`ID ${row.id} · ${d?.infohash||row.infohash||"infohash 未提供"}`;extraFacts.className="metadata-card-facts";for(const [label,value] of [["API 更新时间",d?.updatedAt||row.updatedAt||"未提供"],["API 创建时间",d?.createdAt||row.createdAt||"未提供"],["详情状态",failure?"读取失败":d?"已取得":"未获取"]])extraFacts.append(fact(label,String(value)));more.append(summary,identity,extraFacts);if(d){listSection(more,"标签",d.tags||[]);listSection(more,"类别细项",d.genres||[]);listSection(more,"Tracker",d.trackers||[]);}card.append(more);
    if(files){fileSection(card,files);}else{const waiting=document.createElement("p");waiting.className="muted";waiting.textContent="文件路径和文件数可由 API 详情或 Torrent 元数据补充。";card.append(waiting);}if(needsPathDetail()&&!files){const pending=document.createElement("p");pending.className="detail-pending";pending.textContent="文件路径筛选待补充文件列表后核实";card.append(pending);}root.append(card);
  }
  $("count").textContent=`本页本地筛选后 ${list.length} 条`;
  if(!list.length&&!pending) root.textContent="当前条件下无匹配结果。";
}
const batchBusy=new Set();
async function batchCurrent(kind){
  if(batchBusy.has(kind))return;
  if(kind==="detail"&&localState?.current&&needsPathDetail()&&localState.verifyThrough<localState.current&&pendingPathCount(currentRows())){
    const target=localState.current,key=localState.queryKey;batchBusy.add(kind);status(`正在核实本地第 ${target} 页并补足目标条数…`,"busy");try{await startLocalSearch(key,target);}finally{batchBusy.delete(kind);syncBatchButtons();}return;
  }
  const sequence=searchSequence,list=currentRows(),queue=list.filter(row=>kind==="detail"?!details.has(row.id):needsTorrent(row)),batchIds=queue.map(row=>row.id),total=queue.length;if(!total)return;
  batchBusy.add(kind);error("");status(kind==="detail"?`正在获取 ${total} 条 API 详情…`:`正在补齐 ${total} 条 Torrent 文件大小…`,"busy");syncBatchButtons(list);
  let done=0,failed=0;const workers=Array.from({length:Math.min(kind==="detail"?4:2,queue.length)},async()=>{while(queue.length){const row=queue.shift();try{if(kind==="detail")await getDetail(row);else if(!await enrichFileSizes(row))failed++;}catch(e){if(kind==="detail")detailErrors.set(row.id,e.message);failed++;}done++;if(sequence===searchSequence){status(`批量${kind==="detail"?"详情":"文件大小"} ${done} / ${total}${failed?` · 失败 ${failed}`:""}`,"busy");renderCurrent();}}});
  try{await Promise.all(workers);}finally{batchBusy.delete(kind);syncBatchButtons();}
  if(sequence!==searchSequence)return;
  renderCurrent();
  if(kind==="detail"){
    showRate();
    const apiCalls=batchIds.filter(id=>detailSources.get(id)==="api").length;
    const quotaNote=apiCalls?` · 已同步 API 额度（真实请求 ${apiCalls} 次）`:` · 复用缓存，额度未变`;
    status((failed?`批量完成，失败 ${failed} 条`:`批量完成 ${done} 条`)+quotaNote,failed?"fail":"");
  }else{
    status(`Torrent 文件大小：成功 ${done-failed} 条${failed?` · 失败 ${failed} 条`:""}`,done>failed?"success":"fail");
  }
  if(failed)error(`${failed} 条补全失败，可再次搜索当前页重试。`);
}
// 勾选只选择后续搜索与翻页的补充步骤，不在勾选当下发起请求。
async function runSelectedBatches(sequence=searchSequence){
  for(const [id,kind] of [["bulk-detail","detail"],["bulk-file-sizes","file-sizes"]]){
    if(sequence!==searchSequence)return;
    if($(id).checked)await batchCurrent(kind);
  }
}
function scheduleSelectedBatches(){if($("bulk-detail").checked||$("bulk-file-sizes").checked){const sequence=searchSequence;queueMicrotask(()=>{void runSelectedBatches(sequence);});}}
function apiQueryTerm(){return filters["name-include"].normalize("NFKC").trim().replace(/\s+/gu," ");}
// 只用 API 实际接收的参数判断能否复用当前页；本地筛选参数不参与请求键。
function apiQueryKey(seed=apiQueryTerm()){return JSON.stringify([seed,$("category").value,$("subcategory").value,$("sort").value,$("order").value,$("limit").value]);}
function cachedPage(key){const entry=pageCache.get(key);if(!entry)return null;if(entry.expiresAt<=Date.now()){pageCache.delete(key);return null;}pageCache.delete(key);pageCache.set(key,entry);return entry.data;}
function savePage(key,data){pageCache.delete(key);pageCache.set(key,{data,expiresAt:Date.now()+pageCacheTtlMs});if(pageCache.size>pageCacheLimit)pageCache.delete(pageCache.keys().next().value);}
// 快速切换条件或页码时，同一页尚未完成的请求只发一次。
async function fetchPage(key,params){
  if(pageRequests.has(key))return pageRequests.get(key);
  const request=(async()=>{const response=await fetch("/api/search?"+params),data=await response.json();if(!response.ok){const failure=Error(data.error||"搜索失败");failure.rateLimit=data.rate_limit;throw failure;}savePage(key,data);return data;})();
  pageRequests.set(key,request);
  try{return await request;}finally{pageRequests.delete(key);}
}
// 请求参数与页面展示共用同一串编码结果，避免显示内容与实际请求不一致。
function apiSearchParams(queryKey,page){
  const [query,category,subcategory,sort,order,limit]=JSON.parse(queryKey);
  const params=new URLSearchParams({q:query,page:String(page),limit,sort,order});
  if(category)params.set("category",category);
  if(subcategory)params.set("subCategory",subcategory);
  return params.toString().replace(/\+/g,"%20");
}
async function readApiPage(queryKey,page){
  const params=apiSearchParams(queryKey,page);
  $("api-query-note").textContent=`API 请求：${params}`;
  const pageKey=JSON.stringify([queryKey,page]),cached=cachedPage(pageKey);
  if(cached){$("api-query-note").textContent+=`（页面缓存，未发请求）`;return {data:cached,fromCache:true};}
  const data=await fetchPage(pageKey,params);
  if(data.cached)$("api-query-note").textContent+=`（代理缓存，未请求 Bitsearch）`;
  return {data,fromCache:false};
}
async function loadPage(page) {
  const sequence=++searchSequence,prev=$("prev-page"),next=$("next-page");pendingQueryKey=loadedQueryKey||apiQueryKey(sourceSeed);
  prev.disabled=true;next.disabled=true;error("");status(`正在加载第 ${page} 页…`,"busy");$("page-status").textContent=`正在加载第 ${page} 页`;
  try {
    const limit=Number(JSON.parse(pendingQueryKey)[5]);
    if(!Number.isInteger(limit)||limit<1||limit>100)throw Error("每页条数必须是 1–100 的整数");
    const {data,fromCache}=await readApiPage(pendingQueryKey,page);
    if(!fromCache&&sequence===searchSequence)acceptRate(data.rate_limit);
    if(sequence!==searchSequence)return;
    rows=data.results||[];pageSourceCount=rows.length;detailErrors.clear();loadedQueryKey=pendingQueryKey;pendingQueryKey="";
    const paging=data.pagination||{};
    loadedPage=Number(paging.page)||page;hasNext=Boolean(paging.hasNext);hasPrev=Boolean(paging.hasPrev);
    showPaging(paging);
    $("sync-status").textContent=fromCache?`已复用第 ${loadedPage} 页 API 结果。`:`已取得第 ${loadedPage} 页 API 结果。`;
    prev.hidden=!hasPrev;next.hidden=!hasNext;prev.disabled=false;next.disabled=false;
    prev.textContent="上一页";next.textContent="下一页";
    $("page-status").textContent=`API 第 ${loadedPage} 页${hasNext?"":" · 已到末页"}`;
    renderCurrent();status("搜索列表已取得；详情按勾选项补充");scheduleSelectedBatches();
  } catch(e) {
    if(sequence!==searchSequence)return;
    if(e.rateLimit)acceptRate(e.rateLimit);
    pendingQueryKey="";
    prev.hidden=!hasPrev;next.hidden=!hasNext;prev.disabled=false;next.disabled=false;
    if(page<loadedPage)prev.textContent="重试上一页";
    if(page>loadedPage)next.textContent="重试下一页";
    error(`第 ${page} 页加载失败：${e.message}`);status("加载失败，已保留当前页","fail");
    $("page-status").textContent=`API 第 ${page} 页失败；仍显示第 ${loadedPage||1} 页`;
  }
}
function localTarget(){return Number(filters["local-page-size"]);}
function localFilterKey(){return JSON.stringify(localKeys.map(key=>filters[key]));}
function showLocalPage(index,reused=false){
  const state=localState,page=state.pages[index-1];state.current=index;rows=page.rows;detailErrors.clear();
  const range=page.startApiPage===page.endApiPage?`${page.startApiPage}`:`${page.startApiPage}–${page.endApiPage}`;
  showLocalPaging(page,index);renderCurrent();
  $("page-status").textContent=`本地第 ${index} 页 · 来源 API 第 ${range} 页`;
  $("sync-status").textContent=reused?`已复用本地第 ${index} 页。`:`本地第 ${index} 页取自 API 第 ${range} 页。`;
  const prev=$("prev-page"),next=$("next-page");prev.hidden=index===1;next.hidden=index===state.pages.length&&state.exhausted;prev.disabled=false;next.disabled=false;prev.textContent="上一本地页";next.textContent="下一本地页";
  status(pendingPathCount(currentRows())?"文件路径条件待详情核实":page.exhausted&&rows.length<localTarget()?"API 结果已用尽":"本地页已补齐");showRate();
  scheduleSelectedBatches();
}
async function loadLocalPage(index){
  const state=localState;if(state.pages[index-1]){showLocalPage(index,true);return;}
  const sequence=++searchSequence,target=localTarget();state.pending=true;pendingQueryKey=state.queryKey;
  $("prev-page").disabled=true;$("next-page").disabled=true;error("");status(`正在补齐本地第 ${index} 页…`,"busy");
  const isCurrent=()=>sequence===searchSequence&&localState===state;
  try{
    const page=await assembleLocalPage({start:state.nextCursor,target,seenIds:state.seenIds,identity:torrentIdentity,
      getPage:async apiPage=>{const {data,fromCache}=await readApiPage(state.queryKey,apiPage);if(!fromCache&&isCurrent())acceptRate(data.rate_limit);return data;},
      getDetail:async row=>{if(index<=state.verifyThrough){try{await getDetail(row);}catch(e){throw Error(`详情 ${row.id} 读取失败：${e.message}`);}}return resultDetail(row)||null;},
      matches:(row,detail)=>needsPathDetail()&&!detail?.files?match(row,detail,true):match(row,detail),canMatch:canMatchSize,isCurrent,
      onProgress:(apiPage,found,total)=>{if(isCurrent()){$("page-status").textContent=`本地第 ${index} 页补齐中 · API 第 ${apiPage} 页 · ${found} / ${total} 条`;status("正在补齐本地页…","busy");}}
    });
    if(!isCurrent()||!page)return;
    state.pending=false;pendingQueryKey="";
    if(!page.rows.length&&state.pages.length){state.exhausted=true;showLocalPage(state.current,true);$("sync-status").textContent="API 结果已扫完，没有更多符合条件的本地结果。";return;}
    state.pages.push(page);for(const row of page.rows)state.seenIds.add(torrentIdentity(row));state.nextCursor=page.cursor;state.exhausted=page.exhausted;showLocalPage(index);if(index<state.verifyThrough&&!state.exhausted)return loadLocalPage(index+1);
  }catch(e){
    if(!isCurrent())return;
    state.pending=false;pendingQueryKey="";if(e.rateLimit)acceptRate(e.rateLimit);
    $("prev-page").disabled=false;$("next-page").disabled=false;
    error(`本地第 ${index} 页补齐失败：${e.message}`);status("本地页补齐中断","fail");
    $("page-status").textContent=`本地第 ${index} 页未完成；可重试`;
  }
}
function startLocalSearch(key,verifyThrough=0){
  ++searchSequence;localState={queryKey:key,filterKey:localFilterKey(),pages:[],current:0,nextCursor:{page:1,index:0},seenIds:new Set(),exhausted:false,pending:false,verifyThrough};
  loadedPage=0;loadedQueryKey="";pendingQueryKey="";rows=[];detailErrors.clear();$("results").replaceChildren();$("count").textContent="本地页补齐中";$("site-total").replaceChildren();$("prev-page").hidden=true;$("next-page").hidden=true;syncBatchButtons([]);
  return loadLocalPage(1);
}
function search(){
  const limit=Number($("limit").value);if(!Number.isInteger(limit)||limit<1||limit>100){error("每页条数必须是 1–100 的整数");return;}
  const seed=apiQueryTerm();if(!seed){error("请在“名称包含”填写 Bitsearch 查询词");return;}
  error("");
  const key=apiQueryKey(seed);sourceSeed=seed;
  if(localTarget()>0){
    if(localState?.queryKey===key&&localState.filterKey===localFilterKey()){
      if(localState.pending){$("sync-status").textContent="当前本地页正在补齐，已复用进行中的请求。";return;}
      if(localState.current){showLocalPage(localState.current,true);return;}
      loadLocalPage(1);return;
    }
    chips();startLocalSearch(key);return;
  }
  if(localState){++searchSequence;localState=null;pendingQueryKey="";loadedQueryKey="";loadedPage=0;}
  if(key===pendingQueryKey){$("sync-status").textContent="相同的 API 页正在加载，已复用进行中的请求。";return;}
  if(key===loadedQueryKey&&loadedPage){renderCurrent();$("sync-status").textContent="已复用当前 API 页，仅重新应用本地筛选。";scheduleSelectedBatches();return;}
  loadedQueryKey="";rows=[];detailErrors.clear();loadedPage=0;hasNext=false;hasPrev=false;$("results").replaceChildren();$("count").textContent="搜索中";$("prev-page").hidden=true;$("next-page").hidden=true;syncBatchButtons([]);chips();loadPage(1);
}
function commit(){
  $("local-fill-enabled").checked=Number($("local-page-size").value)>0;
  updateClearButtons();chips();
  $("sync-status").textContent="条件已修改，点击搜索后生效；当前结果仍使用上次搜索条件。";
}
$("form").addEventListener("submit",event=>{event.preventDefault();try{const next=readForm(),limit=Number($("limit").value);if(!Number.isInteger(limit)||limit<1||limit>100)throw Error("每页条数必须是 1–100 的整数");if(!next["name-include"].trim())throw Error("请在“名称包含”填写 Bitsearch 查询词");filters=next;fill();chips();search();}catch(e){error(e.message);} });
for(const key of fields) $(key).addEventListener("change",commit);
$("next-page").onclick=()=>{if(localState){if(localState.current<localState.pages.length)showLocalPage(localState.current+1,true);else if(!localState.exhausted)loadLocalPage(localState.current+1);}else if(sourceSeed)loadPage(loadedPage+1);};
$("prev-page").onclick=()=>{if(localState){if(localState.current>1)showLocalPage(localState.current-1,true);}else if(sourceSeed&&loadedPage>1)loadPage(loadedPage-1);};
for(const key of ["size-min","size-max","size-min-unit","size-max-unit","date-min","date-max","local-page-size"]) $(key).addEventListener("change",commit);
$("local-fill-enabled").addEventListener("change",()=>{$("local-page-size").value=$("local-fill-enabled").checked?String(Math.max(1,Number($("limit").value)||20)):"-1";commit();});
for(const key of ["category","subcategory","sort","order","limit"])$(key).addEventListener("change",()=>{if(key==="category"){$("subcategory").value="";fillSubcategories();}commit();});
function updateClearButtons(){for(const button of document.querySelectorAll(".clear-input"))button.hidden=!$(button.dataset.for).value;}
for(const key of [...fields,"size-min","size-max","date-min","date-max"]){const input=$(key),shell=document.createElement("span"),button=document.createElement("button");shell.className="input-shell";input.parentNode.insertBefore(shell,input);shell.append(input);button.type="button";button.className="clear-input secondary";button.dataset.for=key;button.textContent="×";button.setAttribute("aria-label","清除"+input.closest("label").firstChild.textContent.trim());button.onclick=()=>{input.value="";input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));updateClearButtons();input.focus();};shell.append(button);input.addEventListener("input",updateClearButtons);}
$("clear").onclick=()=>{++searchSequence;filters=initial();rows=[];detailErrors.clear();loadedPage=0;hasNext=false;hasPrev=false;sourceSeed="";loadedQueryKey="";pendingQueryKey="";localState=null;initialCategory="";initialSubcategory="";$("form").reset();$("category").value="";fillSubcategories();$("sort").value="size";$("order").value="desc";$("limit").value="20";fill();chips();$("api-query-note").textContent="API 请求：尚未搜索";$("count").textContent="尚未搜索";$("site-total").textContent="";showRate();$("page-status").textContent="尚未加载页面";$("prev-page").hidden=true;$("next-page").hidden=true;$("results").replaceChildren();syncBatchButtons([]);$("sync-status").textContent="";error("");status("就绪");};
function fillSubcategories(){const select=$("subcategory"),current=select.value||initialSubcategory;select.replaceChildren(new Option("全部子分类",""));const category=categoryTree.find(item=>String(item.id)===$("category").value);for(const item of category?.subCategories||[])select.append(new Option(item.name,String(item.id)));select.value=current;if(select.selectedIndex<0)select.value="";initialSubcategory="";}
let categoriesLoaded=false,categoryLoadPromise=null;
async function loadCategories(){
  if(categoriesLoaded)return;
  if(categoryLoadPromise)return categoryLoadPromise;
  categoryLoadPromise=(async()=>{try{const response=await fetch("/api/categories"),data=await response.json();acceptRate(data.rate_limit);if(!response.ok)throw Error(data.error||"分类读取失败");categoryTree=data.categories||[];const select=$("category"),selected=initialCategory||select.value;select.replaceChildren(new Option("全部分类",""));for(const item of categoryTree)select.append(new Option(item.name,String(item.id)));select.value=selected;if(select.selectedIndex<0)select.value="";fillSubcategories();initialCategory="";categoriesLoaded=true;chips();}catch(e){error("API 分类读取失败："+e.message);}finally{categoryLoadPromise=null;}})();
  return categoryLoadPromise;
}
$("api-more").addEventListener("toggle",()=>{if($("api-more").open)void loadCategories();});
const params=new URLSearchParams(location.search);for(const key of localKeys)if(params.has(key))filters[key]=params.get(key);for(const key of ["size-min-unit","size-max-unit"])if(!Object.hasOwn(units,filters[key]))filters[key]="GB";if(!Number.isInteger(Number(filters["local-page-size"]))||Number(filters["local-page-size"])===0||Number(filters["local-page-size"]) < -1||Number(filters["local-page-size"])>1000)filters["local-page-size"]="-1";if(params.get("q")&&!filters["name-include"])filters["name-include"]=params.get("q");if(params.get("sort"))$("sort").value=params.get("sort");if(params.get("order"))$("order").value=params.get("order");if(params.get("limit"))$("limit").value=params.get("limit");initialCategory=params.get("category")||"";initialSubcategory=params.get("subcategory")||"";fill();chips();if(initialCategory||initialSubcategory)void loadCategories();
