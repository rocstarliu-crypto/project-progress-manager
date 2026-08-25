'use strict';

const APP_VERSION = '1.3.2';
const WORKSPACE_STORAGE_KEY = 'project-progress-manager-v1.3.2-workspace';
const PREVIOUS_WORKSPACE_STORAGE_KEYS = ['project-progress-manager-v1.3.1-workspace','project-progress-manager-v1.3.0-workspace'];
const LEGACY_STORAGE_KEY = 'project-progress-manager-v1.2.0';
const WORKSPACE_KIND = 'project-category-workbook';
const MAX_DEPTH = 4;
const STATUS_OPTIONS = ['未开始', '进行中', '已完成', '延期', '完成但存在问题'];
const STATUS_CLASS = {'未开始':'notstarted','进行中':'doing','已完成':'done','延期':'delay','完成但存在问题':'issue'};
const TYPE_LABEL = {seq:'系统序号',text:'文本',number:'数字',select:'下拉菜单',checkbox:'复选框',status:'状态',progress:'进度'};

let workspace;
let state;
let selectedIds = new Set();
let undoStack = [];
let redoStack = [];
let currentFilePath = null;
let saveTimer = null;
let pendingImport = null;
let editingColumnId = null;
let pendingRenameColumnId = null;
let pendingParentStatusId = null;
let pendingProjectRenameId = null;
let projectMenuTargetId = null;
let dragTaskId = null;
let dragPosition = null;
let dragArmedId = null;
let scrollSyncing = false;

function defaultColumns() {
  return [
    {id:'seq', title:'序号', type:'seq', width:76, visible:true, system:true},
    {id:'name', title:'任务名称', type:'text', width:230, visible:true, system:true, required:true},
    {id:'detail', title:'具体内容', type:'text', width:270, visible:true, system:true},
    {id:'status', title:'状态', type:'status', width:135, visible:true, system:true},
    {id:'progress', title:'进度', type:'progress', width:165, visible:true, system:true}
  ];
}

function sampleTasks() {
  return [
    {id:1,parentId:null,sort:1,expanded:true,name:'项目准备',detail:'完成启动准备和资料清单',status:'进行中',progress:50,values:{}},
    {id:2,parentId:1,sort:1,expanded:true,name:'资料收集',detail:'收集项目基础资料',status:'进行中',progress:70,values:{}},
    {id:3,parentId:2,sort:1,expanded:true,name:'资料清单确认',detail:'核对资料完整性',status:'已完成',progress:100,values:{}},
    {id:4,parentId:2,sort:2,expanded:true,name:'补充缺失资料',detail:'补齐清单中的缺失文件',status:'进行中',progress:40,values:{}},
    {id:5,parentId:1,sort:2,expanded:true,name:'现场调查',detail:'完成现场踏勘与记录',status:'未开始',progress:0,values:{}},
    {id:6,parentId:null,sort:2,expanded:true,name:'报告编制',detail:'完成报告初稿',status:'进行中',progress:35,values:{}},
    {id:7,parentId:6,sort:1,expanded:true,name:'现状分析',detail:'整理监测和现状资料',status:'进行中',progress:35,values:{}},
    {id:8,parentId:null,sort:3,expanded:true,name:'成果审核',detail:'组织审核并提交成果',status:'完成但存在问题',progress:100,values:{}}
  ];
}

function createDefaultState() {
  return {version:2, appVersion:APP_VERSION, nextId:9, columns:defaultColumns(), tasks:sampleTasks(), ui:{depth:4,chartVisible:true,panelWidth:58,filters:{status:[]},chartLinks:{}}};
}

function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
function byId(id) { return state.tasks.find(function(t){ return t.id === Number(id); }); }
function childrenOf(parentId) { return state.tasks.filter(function(t){ return t.parentId === parentId; }).sort(function(a,b){ return a.sort-b.sort; }); }
function hasChildren(id) { return state.tasks.some(function(t){ return t.parentId === id; }); }

function descendantsOf(id) {
  const result = [];
  childrenOf(id).forEach(function(child){ result.push(child); result.push.apply(result, descendantsOf(child.id)); });
  return result;
}

function ancestorsOf(id) {
  const result = [];
  let task = byId(id);
  while (task && task.parentId !== null) { task = byId(task.parentId); if (task) result.unshift(task); }
  return result;
}

function taskDepth(id) { return ancestorsOf(id).length + 1; }

function leafDescendants(id) {
  const task = byId(id);
  if (!task) return [];
  const children = childrenOf(id);
  if (!children.length) return [task];
  let result = [];
  children.forEach(function(child){ result = result.concat(leafDescendants(child.id)); });
  return result;
}

function subtreeHeight(id) {
  const children = childrenOf(id);
  if (!children.length) return 1;
  return 1 + Math.max.apply(null, children.map(function(child){ return subtreeHeight(child.id); }));
}

function effectiveProgress(task) {
  const leaves = leafDescendants(task.id);
  if (leaves.length === 1 && leaves[0].id === task.id) return clampNumber(task.progress,0,100);
  return Math.round(leaves.reduce(function(sum,leaf){ return sum + clampNumber(leaf.progress,0,100); },0) / Math.max(1,leaves.length));
}

function effectiveStatus(task) {
  const leaves = leafDescendants(task.id);
  if (leaves.length === 1 && leaves[0].id === task.id) return STATUS_OPTIONS.includes(task.status) ? task.status : '未开始';
  const statuses = leaves.map(function(leaf){ return STATUS_OPTIONS.includes(leaf.status) ? leaf.status : '未开始'; });
  if (statuses.some(function(s){ return s === '延期'; })) return '延期';
  if (statuses.some(function(s){ return s === '完成但存在问题'; })) return '完成但存在问题';
  if (statuses.every(function(s){ return s === '已完成'; })) return '已完成';
  if (statuses.every(function(s){ return s === '未开始'; })) return '未开始';
  return '进行中';
}

function clampNumber(value,min,max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min,Math.min(max,number));
}

function normalizeSort(parentId) { childrenOf(parentId).forEach(function(task,index){ task.sort=index+1; }); }

function normalizeAllSort() {
  const parents = new Set([null]);
  state.tasks.forEach(function(task){ parents.add(task.parentId); });
  parents.forEach(normalizeSort);
}

function numberMap() {
  const map = new Map();
  function walk(parentId,prefix) {
    childrenOf(parentId).forEach(function(task,index){
      const number = prefix ? prefix + '.' + (index+1) : String(index+1);
      map.set(task.id,number);
      walk(task.id,number);
    });
  }
  walk(null,'');
  return map;
}

function treeOrder() {
  const result = [];
  function walk(parentId) { childrenOf(parentId).forEach(function(task){ result.push(task); walk(task.id); }); }
  walk(null);
  return result;
}

function normalizeState(raw) {
  if (!raw || !Array.isArray(raw.tasks)) return createDefaultState();
  if (!Array.isArray(raw.columns)) {
    const migratedColumns=defaultColumns();const hasOwner=raw.tasks.some(function(task){return String(task.owner||'').trim();});if(hasOwner)migratedColumns.push({id:'legacy_owner',title:'负责人',type:'text',width:150,visible:true,system:false,options:[]});
    raw={version:2,appVersion:APP_VERSION,nextId:raw.nextId,columns:migratedColumns,tasks:raw.tasks.map(function(task,index){const progress=clampNumber(task.progress,0,100);const values={};if(hasOwner)values.legacy_owner=String(task.owner||'');return{id:Number(task.id)||index+1,parentId:task.parent==null?null:Number(task.parent),sort:Number(task.sortorder)||index+1,expanded:task.open!==false,name:String(task.text||task.name||'新任务'),detail:String(task.detail||''),status:progress===100?'已完成':progress===0?'未开始':'进行中',progress:progress,values:values};}),ui:{depth:4,chartVisible:true,panelWidth:58,filters:{status:[]},chartLinks:{}}};
  }
  const value = deepClone(raw);
  value.version = 2; value.appVersion = APP_VERSION;
  value.columns = value.columns.filter(Boolean).map(function(column,index){
    return {id:String(column.id||('column_'+index)),title:String(column.title||'未命名列'),type:column.type||'text',width:clampNumber(column.width||140,55,600),visible:column.visible!==false,system:!!column.system,required:!!column.required,options:Array.isArray(column.options)?column.options.map(String):[]};
  });
  const required = defaultColumns();
  required.forEach(function(base){
    if (!value.columns.some(function(column){ return column.id===base.id; })) value.columns.splice(required.indexOf(base),0,base);
  });
  value.tasks = value.tasks.map(function(task,index){
    return {id:Number(task.id)||index+1,parentId:task.parentId===null||task.parentId===''?null:Number(task.parentId),sort:Number(task.sort)||index+1,expanded:task.expanded!==false,name:String(task.name||task.text||'新任务'),detail:String(task.detail||''),status:STATUS_OPTIONS.includes(task.status)?task.status:'未开始',progress:clampNumber(task.progress,0,100),values:task.values&&typeof task.values==='object'?task.values:{}};
  });
  value.nextId = Math.max(Number(value.nextId)||1, value.tasks.reduce(function(max,t){return Math.max(max,t.id+1);},1));
  value.ui = Object.assign({depth:4,chartVisible:true,panelWidth:58,filters:{status:[]},chartLinks:{}},value.ui||{});
  value.ui.depth = clampNumber(value.ui.depth||4,1,4);
  value.ui.panelWidth = clampNumber(value.ui.panelWidth||58,35,76);
  value.ui.filters = value.ui.filters||{status:[]};
  value.ui.filters.status = Array.isArray(value.ui.filters.status)?value.ui.filters.status:[];
  value.ui.chartLinks = value.ui.chartLinks||{};
  return value;
}

function createEmptyState(columns) {
  const value=normalizeState({version:2,appVersion:APP_VERSION,nextId:1,columns:columns||defaultColumns(),tasks:[],ui:{depth:4,chartVisible:true,panelWidth:58,filters:{status:[]},chartLinks:{}}});
  if(columns)value.columns=columns;
  return value;
}

function createDemoCategoryState(type,columns) {
  const legal=[
    {id:1,parentId:null,sort:1,expanded:true,name:'项目启动',detail:'明确项目目标、范围和总体要求',status:'进行中',progress:55,values:{}},
    {id:2,parentId:1,sort:1,expanded:true,name:'需求确认',detail:'确认需求清单和验收标准',status:'已完成',progress:100,values:{}},
    {id:3,parentId:1,sort:2,expanded:true,name:'实施计划',detail:'制定任务安排和阶段计划',status:'进行中',progress:65,values:{}},
    {id:4,parentId:null,sort:2,expanded:true,name:'项目执行',detail:'按计划推进各项工作任务',status:'进行中',progress:40,values:{}},
    {id:5,parentId:4,sort:1,expanded:true,name:'阶段成果检查',detail:'检查阶段成果和待解决事项',status:'进行中',progress:40,values:{}},
    {id:6,parentId:null,sort:3,expanded:true,name:'验收交付',detail:'完成成果确认、交付和归档',status:'未开始',progress:0,values:{}}
  ];
  const finance=[
    {id:1,parentId:null,sort:1,expanded:true,name:'前期准备',detail:'整理基础资料并确认工作边界',status:'进行中',progress:30,values:{}},
    {id:2,parentId:1,sort:1,expanded:true,name:'资料整理',detail:'完成已有资料的分类和核对',status:'已完成',progress:100,values:{}},
    {id:3,parentId:1,sort:2,expanded:true,name:'工作分工',detail:'明确各项任务和协作关系',status:'进行中',progress:45,values:{}},
    {id:4,parentId:null,sort:2,expanded:true,name:'任务实施',detail:'推进主要工作并记录完成情况',status:'进行中',progress:25,values:{}},
    {id:5,parentId:4,sort:1,expanded:true,name:'质量检查',detail:'检查任务质量并整理问题清单',status:'进行中',progress:25,values:{}},
    {id:6,parentId:null,sort:3,expanded:true,name:'成果归档',detail:'整理最终成果和过程记录',status:'未开始',progress:0,values:{}}
  ];
  const tasks=type==='finance'?finance:legal;
  const value=normalizeState({version:2,appVersion:APP_VERSION,nextId:tasks.length+1,columns:columns||defaultColumns(),tasks:tasks,ui:{depth:4,chartVisible:true,panelWidth:58,filters:{status:[]},chartLinks:{}}});
  if(columns)value.columns=columns;
  return value;
}

function createDefaultWorkspace() {
  const columns=defaultColumns();
  return {kind:WORKSPACE_KIND,version:2,appVersion:APP_VERSION,nextProjectId:3,activeProjectId:'project_1',columns:columns,projects:[
    {id:'project_1',name:'项目一',state:createDemoCategoryState('legal',columns)},
    {id:'project_2',name:'项目二',state:createDemoCategoryState('finance',columns)}
  ]};
}

function mergedWorkspaceColumns(raw,projectsRaw) {
  const sources=[];
  if(Array.isArray(raw&&raw.columns))sources.push(raw.columns);
  (projectsRaw||[]).forEach(function(project){const data=project&&(project.state||project.data);if(data&&Array.isArray(data.columns))sources.push(data.columns);});
  const merged=[];const seen=new Set();
  sources.forEach(function(columns){columns.forEach(function(column){const id=String(column&&column.id||'');if(!id||seen.has(id))return;seen.add(id);merged.push(column);});});
  return normalizeState({tasks:[],columns:merged.length?merged:defaultColumns()}).columns;
}

function ensureProjectUsesSharedColumns(project) {
  project.state.columns=workspace.columns;
  project.state.tasks.forEach(function(task){
    task.values=task.values&&typeof task.values==='object'?task.values:{};
    workspace.columns.filter(function(column){return !column.system;}).forEach(function(column){if(!(column.id in task.values))task.values[column.id]=column.type==='checkbox'?false:'';});
  });
  workspace.columns.filter(function(column){return !column.system;}).forEach(function(column){
    if(!project.state.ui.filters[column.id])project.state.ui.filters[column.id]=defaultCondition(column);
    if(!project.state.ui.chartLinks[column.id])project.state.ui.chartLinks[column.id]=Object.assign({enabled:false},defaultCondition(column));
  });
}

function applySharedColumnsToProjects() {workspace.projects.forEach(ensureProjectUsesSharedColumns);}

function normalizeWorkspace(raw) {
  if(raw&&raw.kind===WORKSPACE_KIND&&Array.isArray(raw.projects)&&raw.projects.length){
    const sourceProjects=raw.projects.filter(Boolean);const columns=mergedWorkspaceColumns(raw,sourceProjects);
    const projects=sourceProjects.map(function(project,index){const projectState=normalizeState(Object.assign({},project.state||project.data||{tasks:[]},{columns:columns}));projectState.columns=columns;return{id:String(project.id||('project_'+(index+1))),name:String(project.name||('项目类别 '+(index+1))).trim()||('项目类别 '+(index+1)),state:projectState};});
    if(!projects.length)return createDefaultWorkspace();
    const active=projects.some(function(project){return project.id===String(raw.activeProjectId);})?String(raw.activeProjectId):projects[0].id;
    const result={kind:WORKSPACE_KIND,version:2,appVersion:APP_VERSION,nextProjectId:Math.max(Number(raw.nextProjectId)||projects.length+1,projects.length+1),activeProjectId:active,columns:columns,projects:projects};
    const previous=workspace;workspace=result;applySharedColumnsToProjects();workspace=previous;return result;
  }
  if(raw&&Array.isArray(raw.tasks)){const columns=normalizeState(raw).columns;const projectState=normalizeState(Object.assign({},raw,{columns:columns}));projectState.columns=columns;const result={kind:WORKSPACE_KIND,version:2,appVersion:APP_VERSION,nextProjectId:2,activeProjectId:'project_1',columns:columns,projects:[{id:'project_1',name:'原项目',state:projectState}]};const previous=workspace;workspace=result;applySharedColumnsToProjects();workspace=previous;return result;}
  return createDefaultWorkspace();
}

function loadLocalWorkspace() {
  try {
    const current=localStorage.getItem(WORKSPACE_STORAGE_KEY);if(current)return normalizeWorkspace(JSON.parse(current));
    if(window.__LOCAL_WEB_INITIAL_STATE__)return normalizeWorkspace(window.__LOCAL_WEB_INITIAL_STATE__);
    for(const previousKey of PREVIOUS_WORKSPACE_STORAGE_KEYS){const previousWorkspace=localStorage.getItem(previousKey);if(previousWorkspace)return normalizeWorkspace(JSON.parse(previousWorkspace));}
    const legacy=localStorage.getItem(LEGACY_STORAGE_KEY);if(legacy)return normalizeWorkspace(JSON.parse(legacy));
  }catch(error){}
  return createDefaultWorkspace();
}

function activeProject(){return workspace.projects.find(function(project){return project.id===workspace.activeProjectId;})||workspace.projects[0];}
function setCurrentState(nextState,adoptColumns){
  const normalized=normalizeState(nextState);
  if(adoptColumns){const imported=normalized.columns;const importedIds=new Set(imported.map(function(column){return column.id;}));workspace.columns=imported.concat(workspace.columns.filter(function(column){return !importedIds.has(column.id);}));}
  normalized.columns=workspace.columns;
  state=normalized;const project=activeProject();if(project)project.state=state;applySharedColumnsToProjects();
}
function serializeState() { return deepClone(state); }
function serializeWorkspace(){
  const project=activeProject();if(project)project.state=state;workspace.appVersion=APP_VERSION;workspace.version=2;applySharedColumnsToProjects();
  const data=deepClone(workspace);data.projects.forEach(function(item){delete item.state.columns;});return data;
}

function saveLocal() {
  try { localStorage.setItem(WORKSPACE_STORAGE_KEY,JSON.stringify(serializeWorkspace())); setSaveLabel('已自动保存'); }
  catch(error) { showToast('自动保存失败','浏览器存储不可用：'+error.message,'error'); }
  if (window.CloudSync && !window.CloudSync.isApplyingRemote()) window.CloudSync.scheduleSave();
}

function markChanged(message) {
  saveLocal(); setSaveLabel('有更改'); updateStatus(message||'已更新');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer=setTimeout(function(){
    if (currentFilePath && window.electronAPI) saveProject(false,true); else setSaveLabel('已自动保存');
  },700);
}

function setSaveLabel(text) { document.getElementById('saveState').textContent=text; }
function updateStatus(text) { document.getElementById('statusMessage').textContent=text; }

function showToast(title,detail,type) {
  const region=document.getElementById('toastRegion'); const toast=document.createElement('div'); toast.className='toast '+(type||'');
  const strong=document.createElement('strong'); strong.textContent=title; const small=document.createElement('small'); small.textContent=detail||'';
  toast.append(strong,small); region.appendChild(toast); setTimeout(function(){ toast.remove(); },5000);
}

function pushUndo() {
  undoStack.push(serializeWorkspace()); if (undoStack.length>60) undoStack.shift(); redoStack=[]; updateUndoButtons();
}

function undo() {
  if (!undoStack.length) return showToast('无法撤销','当前没有可撤销的操作');
  redoStack.push(serializeWorkspace()); workspace=normalizeWorkspace(undoStack.pop());state=activeProject().state;selectedIds.clear(); saveLocal(); renderAll(); updateStatus('已撤销'); updateUndoButtons();
}

function redo() {
  if (!redoStack.length) return showToast('无法重做','当前没有可重做的操作');
  undoStack.push(serializeWorkspace()); workspace=normalizeWorkspace(redoStack.pop());state=activeProject().state;selectedIds.clear(); saveLocal(); renderAll(); updateStatus('已重做'); updateUndoButtons();
}

function updateUndoButtons() { document.getElementById('btnUndo').disabled=!undoStack.length; document.getElementById('btnRedo').disabled=!redoStack.length; }

function isFilterActive() {
  const filters=state.ui.filters;
  if ((filters.status||[]).length) return true;
  return state.columns.some(function(column){
    if (column.system) return false;
    const f=filters[column.id]; if (!f) return false;
    if (column.type==='text') return !!String(f.query||'').trim();
    if (column.type==='number') return f.min!==''&&f.min!=null || f.max!==''&&f.max!=null;
    if (column.type==='select') return Array.isArray(f.values)&&f.values.length>0;
    if (column.type==='checkbox') return f.value==='true'||f.value==='false';
    return false;
  });
}

function taskMatchesFilters(task) {
  const filters=state.ui.filters;
  if ((filters.status||[]).length && !filters.status.includes(effectiveStatus(task))) return false;
  for (const column of state.columns) {
    if (column.system) continue;
    const filter=filters[column.id]; if (!filter) continue;
    const value=task.values[column.id];
    if (column.type==='text' && String(filter.query||'').trim() && !String(value||'').toLowerCase().includes(String(filter.query).trim().toLowerCase())) return false;
    if (column.type==='number') {
      const number=Number(value);
      if (filter.min!==''&&filter.min!=null && (!Number.isFinite(number)||number<Number(filter.min))) return false;
      if (filter.max!==''&&filter.max!=null && (!Number.isFinite(number)||number>Number(filter.max))) return false;
    }
    if (column.type==='select' && Array.isArray(filter.values)&&filter.values.length && !filter.values.includes(String(value||''))) return false;
    if (column.type==='checkbox' && (filter.value==='true'||filter.value==='false') && Boolean(value)!==(filter.value==='true')) return false;
  }
  return true;
}

function visibleRows() {
  const result=[]; const active=isFilterActive(); const include=new Set(); const matched=new Set();
  if (active) state.tasks.forEach(function(task){ if (taskMatchesFilters(task)) { matched.add(task.id); include.add(task.id); ancestorsOf(task.id).forEach(function(a){include.add(a.id);}); } });
  function walk(parentId,ancestorsOpen) {
    childrenOf(parentId).forEach(function(task){
      const depth=taskDepth(task.id); const allowedDepth=depth<=state.ui.depth;
      const allowedFilter=!active||include.has(task.id); const shouldShow=allowedDepth&&allowedFilter&&ancestorsOpen;
      if (shouldShow) result.push({task:task,context:active&&!matched.has(task.id)});
      const nextOpen=active ? ancestorsOpen : ancestorsOpen&&task.expanded;
      if (allowedDepth) walk(task.id,nextOpen);
    });
  }
  walk(null,true); return result;
}

function chartLinkMatches(task) {
  for (const column of state.columns) {
    if (column.system) continue;
    const link=state.ui.chartLinks[column.id]; if (!link||!link.enabled) continue;
    const value=task.values[column.id];
    if (column.type==='text' && String(link.query||'').trim() && !String(value||'').toLowerCase().includes(String(link.query).trim().toLowerCase())) return false;
    if (column.type==='number') {
      const number=Number(value);
      if (link.min!==''&&link.min!=null && (!Number.isFinite(number)||number<Number(link.min))) return false;
      if (link.max!==''&&link.max!=null && (!Number.isFinite(number)||number>Number(link.max))) return false;
    }
    if (column.type==='select' && Array.isArray(link.values)&&link.values.length && !link.values.includes(String(value||''))) return false;
    if (column.type==='checkbox' && (link.value==='true'||link.value==='false') && Boolean(value)!==(link.value==='true')) return false;
  }
  return true;
}

function nextProjectCategoryId(){let id;do{id='project_'+workspace.nextProjectId++;}while(workspace.projects.some(function(project){return project.id===id;}));return id;}
function projectNameExists(name,excludeId){const value=String(name||'').trim().toLowerCase();return workspace.projects.some(function(project){return project.id!==excludeId&&project.name.toLowerCase()===value;});}
function uniqueProjectName(base){let name=String(base||'新项目类别').trim()||'新项目类别';let index=2;while(projectNameExists(name,null))name=String(base||'新项目类别').trim()+' ('+(index++)+')';return name;}
function resetProjectInteraction(){selectedIds.clear();undoStack=[];redoStack=[];pendingImport=null;updateUndoButtons();}

function switchProjectCategory(projectId){const project=workspace.projects.find(function(item){return item.id===projectId;});if(!project||project.id===workspace.activeProjectId)return;closeProjectTabMenu();workspace.activeProjectId=project.id;state=project.state;state.columns=workspace.columns;resetProjectInteraction();saveLocal();renderAll();updateStatus('已切换到项目“'+project.name+'”');}

function renderProjectTabs(){
  const root=document.getElementById('projectTabs');if(!root)return;root.innerHTML='';
  workspace.projects.forEach(function(project){
    const wrapper=document.createElement('div');wrapper.className='project-tab-wrapper'+(project.id===workspace.activeProjectId?' active':'');wrapper.dataset.projectId=project.id;
    const button=document.createElement('button');button.className='project-tab';button.title='切换到“'+project.name+'”';
    const name=document.createElement('span');name.textContent=project.name;const count=document.createElement('small');count.textContent=project.state.tasks.length+'项';button.append(name,count);button.addEventListener('click',function(){switchProjectCategory(project.id);});
    const menu=document.createElement('button');menu.className='project-tab-more';menu.textContent='⋯';menu.title='改名、复制、移动或删除此项目';menu.setAttribute('aria-label','管理“'+project.name+'”');menu.addEventListener('click',function(event){event.stopPropagation();openProjectTabMenu(project.id,menu);});
    wrapper.append(button,menu);root.appendChild(wrapper);
  });
  const active=root.querySelector('.project-tab-wrapper.active');if(active)requestAnimationFrame(function(){active.scrollIntoView({block:'nearest',inline:'nearest'});});
}

function openAddProjectCategory(){document.getElementById('projectCategoryName').value=uniqueProjectName('新项目');openModal('projectCategoryModal');setTimeout(function(){document.getElementById('projectCategoryName').select();},0);}

function confirmAddProjectCategory(){const input=document.getElementById('projectCategoryName');const name=input.value.trim();if(!name)return showToast('不能创建项目','请输入项目名称。','error');if(projectNameExists(name,null))return showToast('不能创建项目','已经存在同名项目，请更换名称。','error');const project={id:nextProjectCategoryId(),name:name,state:createEmptyState(workspace.columns)};workspace.projects.push(project);workspace.activeProjectId=project.id;state=project.state;resetProjectInteraction();closeModal('projectCategoryModal');saveLocal();renderAll();showToast('项目已创建','已切换到“'+name+'”；使用与其他项目完全一致的表格结构。','success');updateStatus('已创建项目“'+name+'”');}

function duplicateProjectCategory(projectId){const source=workspace.projects.find(function(project){return project.id===projectId;});if(!source)return;const copiedState=normalizeState(Object.assign({},deepClone(source.state),{columns:workspace.columns}));copiedState.columns=workspace.columns;const copy={id:nextProjectCategoryId(),name:uniqueProjectName(source.name+' 副本'),state:copiedState};const index=workspace.projects.indexOf(source);workspace.projects.splice(index+1,0,copy);workspace.activeProjectId=copy.id;state=copy.state;resetProjectInteraction();closeProjectTabMenu();saveLocal();renderAll();showToast('项目已复制','已复制“'+source.name+'”并切换到“'+copy.name+'”。','success');}

function openProjectRename(projectId){const project=workspace.projects.find(function(item){return item.id===projectId;});if(!project)return;pendingProjectRenameId=projectId;document.getElementById('projectRenameName').value=project.name;closeProjectTabMenu();openModal('projectRenameModal');setTimeout(function(){document.getElementById('projectRenameName').select();},0);}

function confirmProjectRename(){const project=workspace.projects.find(function(item){return item.id===pendingProjectRenameId;});const name=document.getElementById('projectRenameName').value.trim();if(!project)return closeModal('projectRenameModal');if(!name||projectNameExists(name,project.id))return showToast('项目名称未修改','名称不能为空，也不能与其他项目重复。','error');project.name=name;pendingProjectRenameId=null;closeModal('projectRenameModal');saveLocal();renderProjectTabs();updateStatus('项目名称已修改为“'+name+'”');}

function moveProjectCategory(projectId,direction){const index=workspace.projects.findIndex(function(project){return project.id===projectId;});const target=index+direction;if(index<0||target<0||target>=workspace.projects.length)return;const temp=workspace.projects[index];workspace.projects[index]=workspace.projects[target];workspace.projects[target]=temp;closeProjectTabMenu();saveLocal();renderProjectTabs();updateStatus('项目标签顺序已调整');}

function deleteProjectCategory(projectId){if(workspace.projects.length<=1)return showToast('不能删除','至少需要保留一个项目。','error');const index=workspace.projects.findIndex(function(project){return project.id===projectId;});if(index<0)return;const project=workspace.projects[index];if(!confirm('删除项目“'+project.name+'”会同时删除其中 '+project.state.tasks.length+' 项任务。是否继续？'))return;workspace.projects.splice(index,1);if(workspace.activeProjectId===projectId){const next=workspace.projects[Math.min(index,workspace.projects.length-1)];workspace.activeProjectId=next.id;state=next.state;resetProjectInteraction();}closeProjectTabMenu();saveLocal();renderAll();showToast('项目已删除','已删除“'+project.name+'”。','success');}

function openProjectTabMenu(projectId,anchor){
  const menu=document.getElementById('projectTabMenu');const project=workspace.projects.find(function(item){return item.id===projectId;});if(!menu||!project)return;
  if(menu.classList.contains('open')&&projectMenuTargetId===projectId)return closeProjectTabMenu();
  projectMenuTargetId=projectId;document.getElementById('projectMenuTitle').textContent=project.name;const index=workspace.projects.indexOf(project);
  document.getElementById('projectMenuLeft').disabled=index===0;document.getElementById('projectMenuRight').disabled=index===workspace.projects.length-1;document.getElementById('projectMenuDelete').disabled=workspace.projects.length<=1;
  menu.classList.add('open');menu.setAttribute('aria-hidden','false');const rect=anchor.getBoundingClientRect();const width=menu.offsetWidth||180;menu.style.left=Math.max(8,Math.min(window.innerWidth-width-8,rect.right-width))+'px';menu.style.bottom=(window.innerHeight-rect.top+4)+'px';
}

function closeProjectTabMenu(){const menu=document.getElementById('projectTabMenu');if(menu){menu.classList.remove('open');menu.setAttribute('aria-hidden','true');}projectMenuTargetId=null;}

function renderAll() {
  renderProjectTabs(); renderDepthButtons(); renderFilters(); renderAssociations(); renderDataViews(); renderWorkspace(); updateUndoButtons();
}

function renderDataViews() { const rows=visibleRows(); renderTable(rows); renderChart(rows); renderSummary(rows); }

function renderDepthButtons() { document.querySelectorAll('.depth-btn').forEach(function(button){ button.classList.toggle('active',Number(button.dataset.depth)===state.ui.depth); }); }

function visibleColumns() { return state.columns.filter(function(column){return column.visible!==false;}); }

function renderTable(rows) {
  const cols=document.getElementById('tableCols'); const head=document.getElementById('tableHead'); const body=document.getElementById('taskBody');
  cols.innerHTML=''; head.innerHTML=''; body.innerHTML='';
  const selectCol=document.createElement('col'); selectCol.style.width='42px'; cols.appendChild(selectCol);
  visibleColumns().forEach(function(column){ const col=document.createElement('col'); col.dataset.columnId=column.id; col.style.width=column.width+'px'; cols.appendChild(col); });
  const total=42+visibleColumns().reduce(function(sum,column){return sum+column.width;},0); document.getElementById('taskTable').style.width=total+'px';
  const selectTh=document.createElement('th'); selectTh.className='select-cell'; const selectAll=document.createElement('input'); selectAll.type='checkbox';
  const visibleIds=rows.map(function(row){return row.task.id;}); const checkedCount=visibleIds.filter(function(id){return selectedIds.has(id);}).length;
  selectAll.checked=visibleIds.length>0&&checkedCount===visibleIds.length; selectAll.indeterminate=checkedCount>0&&checkedCount<visibleIds.length;
  selectAll.addEventListener('change',function(){ if (selectAll.checked) rows.forEach(function(row){selectBranch(row.task.id,true);}); else visibleIds.forEach(function(id){selectedIds.delete(id);}); renderDataViews(); });
  selectTh.appendChild(selectAll); head.appendChild(selectTh);
  visibleColumns().forEach(function(column){
    const th=document.createElement('th'); th.dataset.columnId=column.id; const content=document.createElement('div'); content.className='header-content';
    const title=document.createElement('span'); title.className='header-title'; title.textContent=column.title; title.title='双击修改列名称'; title.addEventListener('dblclick',function(){renameColumnPrompt(column.id);}); content.appendChild(title);
    const menu=document.createElement('button'); menu.className='col-menu-btn'; menu.textContent='⋯'; menu.title='列设置'; menu.addEventListener('click',function(){ if(column.system) openColumnManager(); else openColumnModal(column.id); }); content.appendChild(menu); th.appendChild(content);
    const resizer=document.createElement('div'); resizer.className='col-resizer'; resizer.title='拖动调整列宽'; resizer.addEventListener('mousedown',function(event){startColumnResize(event,column.id,th,resizer);}); th.appendChild(resizer); head.appendChild(th);
  });
  if (!rows.length) { const tr=document.createElement('tr'); const td=document.createElement('td'); td.colSpan=visibleColumns().length+1; td.className='empty-state'; td.textContent=isFilterActive()?'没有符合筛选条件的任务':'暂无任务，请点击“＋ 一级任务”'; tr.appendChild(td); body.appendChild(tr); return; }
  const numbers=numberMap();
  rows.forEach(function(item){ body.appendChild(createTaskRow(item.task,item.context,numbers)); });
}

function createTaskRow(task,context,numbers) {
  const tr=document.createElement('tr'); tr.dataset.taskId=task.id; tr.draggable=true; if(context)tr.classList.add('context-row');
  const branchIds=[task.id].concat(descendantsOf(task.id).map(function(t){return t.id;})); const branchSelected=branchIds.filter(function(id){return selectedIds.has(id);}).length;
  if(selectedIds.has(task.id))tr.classList.add('row-selected');
  const selectTd=document.createElement('td'); selectTd.className='select-cell'; const checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.checked=branchSelected===branchIds.length; checkbox.indeterminate=branchSelected>0&&branchSelected<branchIds.length;
  checkbox.addEventListener('click',function(event){event.stopPropagation();}); checkbox.addEventListener('change',function(){selectBranch(task.id,checkbox.checked);renderDataViews();}); selectTd.appendChild(checkbox); tr.appendChild(selectTd);
  visibleColumns().forEach(function(column){ tr.appendChild(createCell(task,column,numbers)); });
  tr.addEventListener('dragstart',function(event){
    if(dragArmedId!==task.id){event.preventDefault();return;} dragTaskId=task.id; event.dataTransfer.effectAllowed='move'; event.dataTransfer.setData('text/plain',String(task.id));
  });
  tr.addEventListener('dragover',function(event){event.preventDefault(); if(!dragTaskId||dragTaskId===task.id)return; clearDragClasses(); const rect=tr.getBoundingClientRect(); const ratio=(event.clientY-rect.top)/rect.height; dragPosition=ratio<.3?'before':ratio>.7?'after':'inside'; tr.classList.add('drag-'+dragPosition); showDragHint(event,dragPosition);});
  tr.addEventListener('dragleave',function(){tr.classList.remove('drag-before','drag-after','drag-inside');});
  tr.addEventListener('drop',function(event){event.preventDefault(); clearDragClasses(); hideDragHint(); if(dragTaskId&&dragTaskId!==task.id)moveByDrag(dragTaskId,task.id,dragPosition);});
  tr.addEventListener('dragend',function(){dragTaskId=null;dragArmedId=null;clearDragClasses();hideDragHint();});
  return tr;
}

function createCell(task,column,numbers) {
  const td=document.createElement('td'); td.dataset.columnId=column.id;
  if(column.id==='seq'){td.className='sequence-cell';td.textContent=numbers.get(task.id)||'';return td;}
  if(column.id==='name'){
    td.className='task-name-cell'; const wrap=document.createElement('div'); wrap.className='task-cell';
    const drag=document.createElement('button');drag.className='drag-handle';drag.textContent='⋮⋮';drag.title='拖动任务';drag.addEventListener('mousedown',function(){dragArmedId=task.id;});wrap.appendChild(drag);
    const indent=document.createElement('span');indent.className='task-indent';indent.style.width=((taskDepth(task.id)-1)*20)+'px';wrap.appendChild(indent);
    const toggle=document.createElement('button');toggle.className='branch-toggle'+(hasChildren(task.id)?'':' placeholder');toggle.textContent=hasChildren(task.id)?(task.expanded?'▼':'▶'):'▶';toggle.title=task.expanded?'收起当前分支':'展开当前分支';toggle.addEventListener('click',function(){toggleBranch(task.id);});wrap.appendChild(toggle);
    const add=document.createElement('button');add.className='add-child'+(taskDepth(task.id)>=MAX_DEPTH?' level-limit':'');add.textContent='＋';add.title=taskDepth(task.id)>=MAX_DEPTH?'已达到四级':'在当前任务下增加子任务';add.addEventListener('click',function(){addChildTask(task.id);});wrap.appendChild(add);
    const input=document.createElement('input');input.className='cell-input';input.value=task.name;input.title=task.name;input.addEventListener('change',function(){updateTaskValue(task.id,'name',input.value);});wrap.appendChild(input);td.appendChild(wrap);return td;
  }
  if(column.id==='detail'){const input=createTextInput(task.detail,function(value){updateTaskValue(task.id,'detail',value);});td.appendChild(input);return td;}
  if(column.id==='status'){
    const status=effectiveStatus(task);
    if(hasChildren(task.id)){const button=document.createElement('button');button.className='parent-computed status-'+STATUS_CLASS[status];button.textContent=status;button.title='父任务状态由子任务自动计算；点击可批量修改全部后代';button.addEventListener('click',function(){promptParentStatus(task.id);});td.appendChild(button);}
    else {const select=createStatusSelect(status);select.addEventListener('change',function(){setLeafStatus(task.id,select.value);});td.appendChild(select);} return td;
  }
  if(column.id==='progress'){td.appendChild(createProgressEditor(task));return td;}
  const value=task.values[column.id];
  if(column.type==='text'){td.appendChild(createTextInput(value||'',function(next){updateCustomValue(task.id,column.id,next);}));}
  else if(column.type==='number'){const input=document.createElement('input');input.className='cell-input';input.type='number';input.value=value==null?'':value;input.addEventListener('change',function(){updateCustomValue(task.id,column.id,input.value===''?'':Number(input.value));});td.appendChild(input);}
  else if(column.type==='select'){const select=document.createElement('select');select.className='cell-input';appendOption(select,'','未设置');column.options.forEach(function(option){appendOption(select,option,option);});select.value=value==null?'':String(value);select.addEventListener('change',function(){updateCustomValue(task.id,column.id,select.value);});td.appendChild(select);}
  else if(column.type==='checkbox'){const wrap=document.createElement('label');wrap.className='checkbox-value';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=Boolean(value);checkbox.addEventListener('change',function(){updateCustomValue(task.id,column.id,checkbox.checked);});wrap.appendChild(checkbox);td.appendChild(wrap);}
  return td;
}

function createTextInput(value,onChange){const input=document.createElement('input');input.className='cell-input';input.value=value==null?'':String(value);input.title=input.value;input.addEventListener('change',function(){onChange(input.value);});return input;}
function appendOption(select,value,text){const option=document.createElement('option');option.value=value;option.textContent=text;select.appendChild(option);}
function createStatusSelect(value){const select=document.createElement('select');select.className='status-select status-'+STATUS_CLASS[value];STATUS_OPTIONS.forEach(function(status){appendOption(select,status,status);});select.value=value;return select;}

function createProgressEditor(task) {
  const wrap=document.createElement('div');wrap.className='progress-editor'+(hasChildren(task.id)?' parent-progress':'');const progress=effectiveProgress(task);
  if(!hasChildren(task.id)){const input=document.createElement('input');input.type='number';input.min='0';input.max='100';input.value=progress;input.addEventListener('change',function(){setLeafProgress(task.id,input.value);});wrap.appendChild(input);}
  const track=document.createElement('div');track.className='progress-track';const fill=document.createElement('div');fill.className='progress-fill';fill.style.width=progress+'%';track.appendChild(fill);wrap.appendChild(track);const label=document.createElement('span');label.className='progress-label';label.textContent=progress+'%';wrap.appendChild(label);return wrap;
}

function renderChart(rows) {
  const body=document.getElementById('chartBody');body.innerHTML='';const numbers=numberMap();const chartRows=rows.filter(function(item){return chartLinkMatches(item.task);});
  if(!chartRows.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=5;td.className='empty-state';td.textContent='没有符合状态图关联条件的任务';tr.appendChild(td);body.appendChild(tr);return;}
  chartRows.forEach(function(item){
    const task=item.task;const status=effectiveStatus(task);const progress=effectiveProgress(task);const lane=status==='未开始'?1:(status==='进行中'||status==='延期'?2:(status==='已完成'?3:4));
    const tr=document.createElement('tr');tr.dataset.taskId=task.id;const taskTd=document.createElement('td');const label=document.createElement('div');label.className='chart-task-label';const num=document.createElement('b');num.textContent=numbers.get(task.id)||'';const name=document.createElement('span');name.textContent=task.name;label.append(num,name);taskTd.appendChild(label);tr.appendChild(taskTd);
    for(let i=1;i<=4;i++){const td=document.createElement('td');td.className='chart-cell';if(i===lane){const card=document.createElement('div');card.className='chart-card '+STATUS_CLASS[status];const title=document.createElement('div');title.className='chart-card-title';const left=document.createElement('span');left.textContent=task.name;const right=document.createElement('span');right.textContent=(status==='延期'?'延期 · ':'')+progress+'%';title.append(left,right);const track=document.createElement('div');track.className='chart-progress';const fill=document.createElement('i');fill.style.width=progress+'%';track.appendChild(fill);card.append(title,track);td.appendChild(card);}tr.appendChild(td);}body.appendChild(tr);
  });
}

function renderSummary(rows) {
  document.getElementById('taskCount').textContent=state.tasks.length;const leaves=state.tasks.filter(function(t){return !hasChildren(t.id);});const overall=leaves.length?Math.round(leaves.reduce(function(sum,t){return sum+clampNumber(t.progress,0,100);},0)/leaves.length):0;document.getElementById('overallProgress').textContent=overall+'%';
  document.getElementById('selectionSummary').textContent=selectedIds.size?'已选择 '+selectedIds.size+' 项（包含隐藏后代）':'未选择任务';
  const matching=rows.filter(function(r){return taskMatchesFilters(r.task);}).length;document.getElementById('activeFilterSummary').textContent=isFilterActive()?'筛选结果：'+matching+' 项，父级路径已保留':'';
  const hasSelection=selectedIds.size>0;['btnDelete','btnPromote','btnDemote','btnMoveUp','btnMoveDown','btnMoveTo'].forEach(function(id){document.getElementById(id).disabled=!hasSelection;});
}

function renderWorkspace() {
  const visible=state.ui.chartVisible!==false;document.getElementById('chartVisible').checked=visible;document.getElementById('chartPanel').classList.toggle('hidden',!visible);document.getElementById('panelResize').classList.toggle('hidden',!visible);document.getElementById('tablePanel').classList.toggle('full-width',!visible);document.getElementById('tablePanel').style.width=visible?state.ui.panelWidth+'%':'100%';document.getElementById('chartAssociation').classList.toggle('hidden',!visible);
}

function renderFilters() {
  const bar=document.getElementById('filterBar');bar.innerHTML='';bar.appendChild(createMultiFilter('状态',STATUS_OPTIONS,state.ui.filters.status,function(values){state.ui.filters.status=values;saveLocal();renderDataViews();renderFilters();}));
  state.columns.filter(function(c){return !c.system;}).forEach(function(column){
    const filter=state.ui.filters[column.id]||(state.ui.filters[column.id]=defaultCondition(column));
    if(column.type==='text')bar.appendChild(createTextFilter(column.title,filter,'query'));
    else if(column.type==='number')bar.appendChild(createNumberFilter(column.title,filter));
    else if(column.type==='select')bar.appendChild(createMultiFilter(column.title,uniqueOptions(column),filter.values||[],function(values){filter.values=values;saveLocal();renderDataViews();renderFilters();}));
    else if(column.type==='checkbox')bar.appendChild(createBooleanFilter(column.title,filter));
  });
}

function defaultCondition(column){if(column.type==='text')return{query:''};if(column.type==='number')return{min:'',max:''};if(column.type==='select')return{values:[]};return{value:''};}
function uniqueOptions(column){const options=(column.options||[]).slice();state.tasks.forEach(function(task){const value=task.values[column.id];if(value!==''&&value!=null&&!options.includes(String(value)))options.push(String(value));});return options;}

function createMultiFilter(title,options,selected,onChange) {
  const wrap=document.createElement('div');wrap.className='filter-control';const name=document.createElement('span');name.textContent=title;name.title=title;wrap.appendChild(name);const details=document.createElement('details');details.className='filter-details';const summary=document.createElement('summary');summary.textContent=selected.length?'已选 '+selected.length+' 项':'全部';details.appendChild(summary);const pop=document.createElement('div');pop.className='filter-popover';
  options.forEach(function(option){const label=document.createElement('label');const check=document.createElement('input');check.type='checkbox';check.checked=selected.includes(option);check.addEventListener('change',function(){const next=selected.slice();const index=next.indexOf(option);if(check.checked&&index<0)next.push(option);if(!check.checked&&index>=0)next.splice(index,1);onChange(next);});label.append(check,document.createTextNode(option));pop.appendChild(label);});
  if(!options.length){const empty=document.createElement('span');empty.textContent='暂无选项';pop.appendChild(empty);}details.appendChild(pop);wrap.appendChild(details);return wrap;
}

function createTextFilter(title,filter,key) {const wrap=document.createElement('label');wrap.className='filter-control';const name=document.createElement('span');name.textContent=title;name.title=title;const input=document.createElement('input');input.type='text';input.placeholder='包含文字';input.value=filter[key]||'';input.addEventListener('input',function(){filter[key]=input.value;saveLocal();renderDataViews();});wrap.append(name,input);return wrap;}

function createNumberFilter(title,filter) {const wrap=document.createElement('label');wrap.className='filter-control';const name=document.createElement('span');name.textContent=title;const min=document.createElement('input');min.type='number';min.placeholder='最小';min.value=filter.min==null?'':filter.min;const max=document.createElement('input');max.type='number';max.placeholder='最大';max.value=filter.max==null?'':filter.max;function apply(){filter.min=min.value;filter.max=max.value;saveLocal();renderDataViews();}min.addEventListener('input',apply);max.addEventListener('input',apply);wrap.append(name,min,document.createTextNode('—'),max);return wrap;}

function createBooleanFilter(title,filter) {const wrap=document.createElement('label');wrap.className='filter-control';const name=document.createElement('span');name.textContent=title;const select=document.createElement('select');appendOption(select,'','全部');appendOption(select,'true','是');appendOption(select,'false','否');select.value=filter.value||'';select.addEventListener('change',function(){filter.value=select.value;saveLocal();renderDataViews();});wrap.append(name,select);return wrap;}

function renderAssociations() {
  const root=document.getElementById('associationControls');root.innerHTML='';const custom=state.columns.filter(function(c){return !c.system;});if(!custom.length){const empty=document.createElement('span');empty.className='association-empty';empty.textContent='添加自定义列后，这里会自动出现对应的图表关联选项。';root.appendChild(empty);return;}
  custom.forEach(function(column){
    const link=state.ui.chartLinks[column.id]||(state.ui.chartLinks[column.id]=Object.assign({enabled:false},defaultCondition(column)));const item=document.createElement('div');item.className='association-item'+(link.enabled?' active':'');const label=document.createElement('label');const check=document.createElement('input');check.type='checkbox';check.checked=!!link.enabled;check.addEventListener('change',function(){link.enabled=check.checked;saveLocal();renderAssociations();renderChart(visibleRows());});label.append(check,document.createTextNode(column.title));item.appendChild(label);
    if(link.enabled){const config=document.createElement('span');config.className='association-config';appendAssociationControl(config,column,link);item.appendChild(config);}root.appendChild(item);
  });
}

function appendAssociationControl(root,column,link) {
  if(column.type==='text'){const input=document.createElement('input');input.type='text';input.placeholder='包含文字';input.value=link.query||'';input.addEventListener('input',function(){link.query=input.value;saveLocal();renderChart(visibleRows());});root.appendChild(input);}
  else if(column.type==='number'){const min=document.createElement('input');min.type='number';min.placeholder='最小';min.value=link.min||'';const max=document.createElement('input');max.type='number';max.placeholder='最大';max.value=link.max||'';function apply(){link.min=min.value;link.max=max.value;saveLocal();renderChart(visibleRows());}min.addEventListener('input',apply);max.addEventListener('input',apply);root.append(min,document.createTextNode('—'),max);}
  else if(column.type==='select'){
    const details=document.createElement('details');details.className='filter-details';const summary=document.createElement('summary');summary.textContent=(link.values||[]).length?'已选 '+link.values.length:'全部';details.appendChild(summary);const pop=document.createElement('div');pop.className='filter-popover';uniqueOptions(column).forEach(function(option){const label=document.createElement('label');const check=document.createElement('input');check.type='checkbox';check.checked=(link.values||[]).includes(option);check.addEventListener('change',function(){link.values=link.values||[];if(check.checked&&!link.values.includes(option))link.values.push(option);if(!check.checked)link.values=link.values.filter(function(v){return v!==option;});saveLocal();renderAssociations();renderChart(visibleRows());});label.append(check,document.createTextNode(option));pop.appendChild(label);});details.appendChild(pop);root.appendChild(details);
  } else if(column.type==='checkbox'){const select=document.createElement('select');appendOption(select,'','全部');appendOption(select,'true','是');appendOption(select,'false','否');select.value=link.value||'';select.addEventListener('change',function(){link.value=select.value;saveLocal();renderChart(visibleRows());});root.appendChild(select);}
}

function setDepth(depth) {pushUndo();state.ui.depth=clampNumber(depth,1,4);state.tasks.forEach(function(task){task.expanded=taskDepth(task.id)<state.ui.depth;});markChanged('已展开到 '+state.ui.depth+' 级');renderAll();}
function expandAll() {pushUndo();state.ui.depth=4;state.tasks.forEach(function(t){t.expanded=true;});markChanged('已全部展开');renderAll();}
function collapseAll() {pushUndo();state.ui.depth=1;state.tasks.forEach(function(t){t.expanded=false;});markChanged('已全部收起，仅显示一级任务');renderAll();}
function toggleBranch(id) {const task=byId(id);if(!task||!hasChildren(id))return;pushUndo();const opening=!task.expanded;task.expanded=opening;if(opening){const childDepth=Math.min(MAX_DEPTH,taskDepth(task.id)+1);state.ui.depth=Math.max(state.ui.depth,childDepth);}markChanged(opening?'已展开当前任务，并显示到 '+state.ui.depth+' 级':'已收起当前任务');renderAll();}

function selectBranch(id,checked) {const ids=[id].concat(descendantsOf(id).map(function(t){return t.id;}));ids.forEach(function(taskId){if(checked)selectedIds.add(taskId);else selectedIds.delete(taskId);});}

function addRootTask() {pushUndo();state.tasks.push({id:state.nextId++,parentId:null,sort:childrenOf(null).length+1,expanded:true,name:'新任务',detail:'',status:'未开始',progress:0,values:{}});markChanged('已添加一级任务');renderAll();}

function addChildTask(parentId) {const parent=byId(parentId);if(!parent)return;if(taskDepth(parentId)>=MAX_DEPTH)return showToast('不能增加子任务','当前任务已经是四级，最大层级为四级。','error');pushUndo();parent.expanded=true;state.ui.depth=Math.max(state.ui.depth,Math.min(4,taskDepth(parentId)+1));state.tasks.push({id:state.nextId++,parentId:parentId,sort:childrenOf(parentId).length+1,expanded:true,name:'新子任务',detail:'',status:'未开始',progress:0,values:{}});markChanged('已在“'+parent.name+'”下增加子任务');renderAll();}

function updateTaskValue(id,key,value) {const task=byId(id);if(!task)return;pushUndo();task[key]=key==='progress'?clampNumber(value,0,100):String(value);markChanged('已修改'+(key==='name'?'任务名称':'具体内容'));renderDataViews();}
function updateCustomValue(id,columnId,value){const task=byId(id);if(!task)return;pushUndo();task.values[columnId]=value;markChanged('已修改自定义列内容');renderDataViews();renderFilters();renderAssociations();}

function setLeafProgress(id,value) {const task=byId(id);if(!task||hasChildren(id))return;pushUndo();task.progress=clampNumber(value,0,100);if(task.progress===100&&task.status!=='完成但存在问题')task.status='已完成';else if(task.progress===0&&task.status==='进行中')task.status='未开始';else if(task.progress>0&&task.progress<100&&(task.status==='未开始'||task.status==='已完成'))task.status='进行中';markChanged('已更新任务进度');renderDataViews();}

function applyStatusToLeaf(task,status) {task.status=status;if(status==='已完成'||status==='完成但存在问题')task.progress=100;else if(status==='未开始')task.progress=0;else if(status==='进行中'&&task.progress===0)task.progress=1;}

function setLeafStatus(id,status) {const task=byId(id);if(!task||hasChildren(id)||!STATUS_OPTIONS.includes(status))return;pushUndo();applyStatusToLeaf(task,status);markChanged('状态已改为“'+status+'”');renderDataViews();renderFilters();}

function promptParentStatus(id) {const task=byId(id);if(!task)return;pendingParentStatusId=id;document.getElementById('parentStatusHelp').textContent='父任务“'+task.name+'”的状态由后代自动计算。选择状态后，将应用到下面全部 '+leafDescendants(id).length+' 个最末级任务。';document.getElementById('parentStatusSelect').value=effectiveStatus(task);openModal('parentStatusModal');}

function confirmParentStatus() {const task=byId(pendingParentStatusId);const status=document.getElementById('parentStatusSelect').value;if(!task||!STATUS_OPTIONS.includes(status))return;pushUndo();leafDescendants(task.id).forEach(function(leaf){applyStatusToLeaf(leaf,status);});pendingParentStatusId=null;closeModal('parentStatusModal');markChanged('已批量更新父任务下全部后代');renderAll();}

function selectedRootTasks() {return Array.from(selectedIds).map(byId).filter(Boolean).filter(function(task){return !ancestorsOf(task.id).some(function(parent){return selectedIds.has(parent.id);});}).sort(function(a,b){return treeOrder().indexOf(a)-treeOrder().indexOf(b);});}

function deleteSelected() {if(!selectedIds.size)return;const roots=selectedRootTasks();const remove=new Set();roots.forEach(function(root){remove.add(root.id);descendantsOf(root.id).forEach(function(t){remove.add(t.id);});});if(!confirm('将删除 '+roots.length+' 个选中分支，共 '+remove.size+' 项任务（包括所有隐藏子任务）。是否继续？'))return;pushUndo();state.tasks=state.tasks.filter(function(t){return !remove.has(t.id);});selectedIds.clear();normalizeAllSort();markChanged('已删除 '+remove.size+' 项任务');renderAll();}

function promoteSelected() {const roots=selectedRootTasks().filter(function(task){return task.parentId!==null;});if(!roots.length)return showToast('无法提级','选中的任务已经是一级，或没有可提级任务。');pushUndo();roots.forEach(function(task,index){const parent=byId(task.parentId);task.parentId=parent?parent.parentId:null;task.sort=(parent?parent.sort:childrenOf(null).length+1)+0.01*(index+1);});normalizeAllSort();markChanged('已提级 '+roots.length+' 个任务分支');renderAll();}

function demoteSelected() {const roots=selectedRootTasks();if(!roots.length)return;const movable=[];roots.forEach(function(task){const siblings=childrenOf(task.parentId);const index=siblings.findIndex(function(t){return t.id===task.id;});let previous=null;for(let i=index-1;i>=0;i--){if(!selectedIds.has(siblings[i].id)){previous=siblings[i];break;}}if(previous&&taskDepth(previous.id)+subtreeHeight(task.id)<=MAX_DEPTH)movable.push({task:task,parent:previous});});if(!movable.length)return showToast('无法降级','前面没有可作为父任务的同级任务，或降级后会超过四级。');pushUndo();movable.forEach(function(item){item.task.parentId=item.parent.id;item.task.sort=childrenOf(item.parent.id).length+1;item.parent.expanded=true;});normalizeAllSort();markChanged('已降级 '+movable.length+' 个任务分支');renderAll();}

function moveSelection(direction) {const selected=new Set(selectedRootTasks().map(function(t){return t.id;}));if(!selected.size)return;let changed=false;pushUndo();const parents=new Set(selectedRootTasks().map(function(t){return t.parentId;}));parents.forEach(function(parentId){const siblings=childrenOf(parentId);if(direction<0){for(let i=1;i<siblings.length;i++){if(selected.has(siblings[i].id)&&!selected.has(siblings[i-1].id)){const temp=siblings[i-1];siblings[i-1]=siblings[i];siblings[i]=temp;changed=true;}}}else{for(let i=siblings.length-2;i>=0;i--){if(selected.has(siblings[i].id)&&!selected.has(siblings[i+1].id)){const temp=siblings[i+1];siblings[i+1]=siblings[i];siblings[i]=temp;changed=true;}}}siblings.forEach(function(t,index){t.sort=index+1;});});if(!changed){undoStack.pop();updateUndoButtons();return showToast('无法移动','选中任务已经到达当前层级边界。');}markChanged(direction<0?'已上移选中任务':'已下移选中任务');renderAll();}

function openMoveModal() {if(!selectedIds.size)return;const roots=selectedRootTasks();const blocked=new Set();roots.forEach(function(root){blocked.add(root.id);descendantsOf(root.id).forEach(function(t){blocked.add(t.id);});});const select=document.getElementById('moveTarget');select.innerHTML='';appendOption(select,'root','一级任务区');const numbers=numberMap();treeOrder().forEach(function(task){if(blocked.has(task.id))return;const fits=roots.every(function(root){return taskDepth(task.id)+subtreeHeight(root.id)<=MAX_DEPTH;});if(fits)appendOption(select,String(task.id),(numbers.get(task.id)||'')+' '+task.name);});openModal('moveModal');}

function confirmMoveSelected() {const value=document.getElementById('moveTarget').value;const parentId=value==='root'?null:Number(value);const roots=selectedRootTasks();if(parentId!==null&&!byId(parentId))return showToast('移动失败','目标任务已不存在，请重新选择。','error');if(parentId!==null&&roots.some(function(root){return taskDepth(parentId)+subtreeHeight(root.id)>MAX_DEPTH;}))return showToast('移动失败','移动后会超过四级，请选择更高层级的目标。','error');pushUndo();roots.forEach(function(task){task.parentId=parentId;task.sort=childrenOf(parentId).length+1;});if(parentId!==null)byId(parentId).expanded=true;normalizeAllSort();closeModal('moveModal');markChanged('已移动 '+roots.length+' 个任务分支');renderAll();}

function batchSetStatus(status) {if(!status)return;if(!selectedIds.size){document.getElementById('batchStatus').value='';return showToast('没有选中任务','请先勾选需要批量修改的任务。');}if(!confirm('将“'+status+'”应用到选中任务及其全部后代，是否继续？')){document.getElementById('batchStatus').value='';return;}pushUndo();const leaves=new Set();selectedRootTasks().forEach(function(root){leafDescendants(root.id).forEach(function(leaf){leaves.add(leaf.id);});});leaves.forEach(function(id){applyStatusToLeaf(byId(id),status);});document.getElementById('batchStatus').value='';markChanged('已批量修改 '+leaves.size+' 个最末级任务');renderAll();}

function moveByDrag(sourceId,targetId,position) {const source=byId(sourceId),target=byId(targetId);if(!source||!target)return;const blocked=new Set([source.id].concat(descendantsOf(source.id).map(function(t){return t.id;})));if(blocked.has(targetId))return showToast('不能移动','不能把任务移动到自身或自己的后代中。','error');let newParent=position==='inside'?target.id:target.parentId;const newDepth=newParent===null?1:taskDepth(newParent)+1;if(newDepth+subtreeHeight(source.id)-1>MAX_DEPTH)return showToast('不能移动','移动后会超过四级任务限制。','error');pushUndo();source.parentId=newParent;if(position==='inside'){source.sort=childrenOf(newParent).length+1;target.expanded=true;}else{const siblings=childrenOf(newParent).filter(function(t){return t.id!==source.id;});const index=siblings.findIndex(function(t){return t.id===target.id;});siblings.splice(position==='before'?index:index+1,0,source);siblings.forEach(function(t,i){t.sort=i+1;});}normalizeAllSort();markChanged(position==='inside'?'任务已成为目标的子任务':'任务顺序已调整');renderAll();}

function clearDragClasses(){document.querySelectorAll('#taskBody tr').forEach(function(row){row.classList.remove('drag-before','drag-after','drag-inside');});}
function showDragHint(event,position){const hint=document.getElementById('dragHint');hint.textContent={before:'放到目标之前',after:'放到目标之后',inside:'成为目标的子任务'}[position];hint.style.left=(event.clientX+14)+'px';hint.style.top=(event.clientY+14)+'px';hint.classList.add('show');}
function hideDragHint(){document.getElementById('dragHint').classList.remove('show');}

function openColumnModal(columnId) {editingColumnId=columnId||null;const column=columnId?state.columns.find(function(c){return c.id===columnId;}):null;if(column&&column.system)return renameColumnPrompt(column.id);document.getElementById('columnModalTitle').textContent=column?'编辑自定义列':'添加自定义列';document.getElementById('columnName').value=column?column.title:'';document.getElementById('columnType').value=column?column.type:'text';document.getElementById('columnType').disabled=!!column;document.getElementById('columnOptions').value=column&&column.options?column.options.join('\n'):'';toggleColumnOptions();openModal('columnModal');}

function toggleColumnOptions(){document.getElementById('columnOptionsWrap').classList.toggle('hidden',document.getElementById('columnType').value!=='select');}

function saveColumn() {const name=document.getElementById('columnName').value.trim();const type=document.getElementById('columnType').value;if(!name)return showToast('不能保存列','请输入列名称。','error');const duplicate=workspace.columns.some(function(c){return c.id!==editingColumnId&&c.title.toLowerCase()===name.toLowerCase();});if(duplicate)return showToast('不能保存列','列名称“'+name+'”已经存在，请使用其他名称。','error');const options=document.getElementById('columnOptions').value.split(/\r?\n|,/).map(function(v){return v.trim();}).filter(Boolean).filter(function(v,i,a){return a.indexOf(v)===i;});if(type==='select'&&!options.length)return showToast('不能保存列','下拉菜单至少需要一个选项。','error');pushUndo();if(editingColumnId){const column=workspace.columns.find(function(c){return c.id===editingColumnId;});column.title=name;if(column.type==='select')column.options=options;}else{const id='custom_'+Date.now().toString(36);const column={id:id,title:name,type:type,width:type==='text'?170:140,visible:true,system:false,options:type==='select'?options:[]};workspace.columns.push(column);workspace.projects.forEach(function(project){project.state.tasks.forEach(function(task){task.values[id]=type==='checkbox'?false:'';});project.state.ui.filters[id]=defaultCondition(column);project.state.ui.chartLinks[id]=Object.assign({enabled:false},defaultCondition(column));});}applySharedColumnsToProjects();closeModal('columnModal');editingColumnId=null;markChanged('公共列已保存，所有项目标签已同步');renderAll();}

function renameColumnPrompt(columnId) {const column=state.columns.find(function(c){return c.id===columnId;});if(!column)return;pendingRenameColumnId=columnId;document.getElementById('renameColumnName').value=column.title;openModal('renameModal');setTimeout(function(){document.getElementById('renameColumnName').focus();document.getElementById('renameColumnName').select();},0);}

function confirmRenameColumn() {const column=state.columns.find(function(c){return c.id===pendingRenameColumnId;});if(!column)return;const next=document.getElementById('renameColumnName').value.trim();if(!next)return showToast('不能改名','列名称不能为空。','error');if(state.columns.some(function(c){return c.id!==column.id&&c.title.toLowerCase()===next.toLowerCase();}))return showToast('不能改名','已经存在同名列。','error');if(next===column.title){closeModal('renameModal');return;}pushUndo();column.title=next;pendingRenameColumnId=null;closeModal('renameModal');markChanged('列名称已修改，筛选区和状态图关联区已同步');renderAll();}

function openColumnManager() {renderColumnManager();openModal('manageColumnsModal');}

function renderColumnManager() {const root=document.getElementById('columnManagerList');root.innerHTML='';state.columns.forEach(function(column){const row=document.createElement('div');row.className='column-manager-row';const grip=document.createElement('span');grip.className='grip';grip.textContent='⋮⋮';const name=document.createElement('input');name.type='text';name.value=column.title;name.addEventListener('change',function(){const next=name.value.trim();if(!next||state.columns.some(function(c){return c.id!==column.id&&c.title.toLowerCase()===next.toLowerCase();})){name.value=column.title;return showToast('列名未修改','列名称不能为空或重复。','error');}pushUndo();column.title=next;markChanged('列名称已修改');renderAll();renderColumnManager();});const type=document.createElement('small');type.textContent=TYPE_LABEL[column.type]||column.type;const width=document.createElement('span');width.textContent=column.width+' px';const visible=document.createElement('label');const check=document.createElement('input');check.type='checkbox';check.checked=column.visible!==false;check.disabled=!!column.required;check.addEventListener('change',function(){pushUndo();column.visible=check.checked;markChanged(check.checked?'列已显示':'列已隐藏，数据仍然保留');renderAll();renderColumnManager();});visible.append(check,document.createTextNode('显示'));const action=document.createElement('button');action.textContent=column.system?'改名':'编辑';action.addEventListener('click',function(){closeModal('manageColumnsModal');column.system?renameColumnPrompt(column.id):openColumnModal(column.id);});row.append(grip,name,type,width,visible,action);if(!column.system){const del=document.createElement('button');del.textContent='删除';del.addEventListener('click',function(){deleteColumn(column.id);});row.appendChild(del);row.style.gridTemplateColumns='34px 1.2fr 100px 90px 72px 64px 64px';}root.appendChild(row);});}

function deleteColumn(columnId) {const column=workspace.columns.find(function(c){return c.id===columnId;});if(!column||column.system)return;if(!confirm('删除公共列“'+column.title+'”后，全部项目中的该列数据、筛选和状态图关联设置都会删除。是否继续？'))return;pushUndo();workspace.columns=workspace.columns.filter(function(c){return c.id!==columnId;});workspace.projects.forEach(function(project){project.state.columns=workspace.columns;project.state.tasks.forEach(function(task){delete task.values[columnId];});delete project.state.ui.filters[columnId];delete project.state.ui.chartLinks[columnId];});state=activeProject().state;markChanged('已从全部项目删除自定义列“'+column.title+'”');renderAll();renderColumnManager();}

function startColumnResize(event,columnId,th,resizer) {event.preventDefault();event.stopPropagation();const column=state.columns.find(function(c){return c.id===columnId;});if(!column)return;const startX=event.clientX,startWidth=column.width,panel=document.getElementById('tablePanel'),panelRect=panel.getBoundingClientRect(),guide=document.getElementById('columnGuide'),guideText=document.getElementById('columnGuideText'),startRight=th.getBoundingClientRect().right-panelRect.left;resizer.classList.add('active');guide.classList.add('show');function move(e){const min=column.id==='seq'?55:(column.id==='name'||column.id==='detail'?120:75);const width=Math.round(clampNumber(startWidth+(e.clientX-startX),min,600));const col=document.querySelector('#tableCols col[data-column-id="'+columnId+'"]');if(col)col.style.width=width+'px';guide.style.left=(startRight+(width-startWidth))+'px';guideText.textContent=width+' px';}function up(e){document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);resizer.classList.remove('active');guide.classList.remove('show');const min=column.id==='seq'?55:(column.id==='name'||column.id==='detail'?120:75);pushUndo();column.width=Math.round(clampNumber(startWidth+(e.clientX-startX),min,600));markChanged('列宽已调整为 '+column.width+' px');renderDataViews();}document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);}

function clearFilters() {pushUndo();state.ui.filters={status:[]};state.columns.filter(function(c){return !c.system;}).forEach(function(column){state.ui.filters[column.id]=defaultCondition(column);});markChanged('已清除全部筛选');renderAll();}

function openModal(id){const modal=document.getElementById(id);modal.classList.add('open');modal.setAttribute('aria-hidden','false');}
function closeModal(id){const modal=document.getElementById(id);modal.classList.remove('open');modal.setAttribute('aria-hidden','true');}

async function exportExcel() {
  if(typeof ExcelJS==='undefined')return showToast('导出失败','Excel 组件没有加载，请确认 libs/exceljs.min.js 与网页在同一文件夹。','error');
  try{
    updateStatus('正在生成 Excel…');const workbook=new ExcelJS.Workbook();workbook.creator='项目进度管理 V'+APP_VERSION;workbook.created=new Date();const sheet=workbook.addWorksheet('任务数据');const numbers=numberMap();const exportColumns=state.columns.filter(function(c){return c.id!=='seq';});
    const headers=['任务ID','父任务ID','序号','层级'].concat(exportColumns.map(function(c){return c.title;}));sheet.addRow(headers);
    treeOrder().forEach(function(task){const row=[task.id,task.parentId==null?'':task.parentId,numbers.get(task.id),taskDepth(task.id)];exportColumns.forEach(function(column){if(column.id==='name')row.push(task.name);else if(column.id==='detail')row.push(task.detail);else if(column.id==='status')row.push(effectiveStatus(task));else if(column.id==='progress')row.push(effectiveProgress(task));else row.push(column.type==='checkbox'?(task.values[column.id]?'是':'否'):(task.values[column.id]??''));});sheet.addRow(row);});
    sheet.views=[{state:'frozen',ySplit:1,xSplit:4}];sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF315B8A'}};sheet.getRow(1).alignment={vertical:'middle',horizontal:'center'};sheet.getRow(1).height=24;
    sheet.columns.forEach(function(column,index){if(index<4)column.width=[10,12,14,8][index];else{const config=exportColumns[index-4];column.width=Math.max(10,Math.min(80,Math.round(config.width/7)));}column.eachCell(function(cell){cell.border={top:{style:'thin',color:{argb:'FFD5DCE4'}},left:{style:'thin',color:{argb:'FFD5DCE4'}},bottom:{style:'thin',color:{argb:'FFD5DCE4'}},right:{style:'thin',color:{argb:'FFD5DCE4'}}};});});
    const config=workbook.addWorksheet('列配置');config.addRow(['字段ID','显示名称','类型','宽度(px)','选项(JSON)','是否显示','系统字段','顺序','版本']);state.columns.forEach(function(column,index){config.addRow([column.id,column.title,column.type,column.width,JSON.stringify(column.options||[]),column.visible!==false?'是':'否',column.system?'是':'否',index+1,APP_VERSION]);});config.getRow(1).font={bold:true};config.columns=[{width:24},{width:20},{width:14},{width:12},{width:38},{width:12},{width:12},{width:10},{width:12}];config.state='visible';
    const project=activeProject();const buffer=await workbook.xlsx.writeBuffer();downloadBlob(new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),safeFileName(project?project.name:'项目进度')+'_'+dateStamp()+'.xlsx');updateStatus('当前项目的 Excel 已导出');showToast('导出成功','已导出当前项目“'+(project?project.name:'项目进度')+'”，包含“任务数据”和“列配置”。','success');
  }catch(error){showToast('Excel 导出失败','原因：'+error.message+'。当前项目数据没有被修改。','error');updateStatus('Excel 导出失败');}
}

function downloadBlob(blob,fileName){const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=fileName;document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(function(){URL.revokeObjectURL(url);},1000);}
function dateStamp(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function safeFileName(name){return String(name||'项目进度').replace(/[\\/:*?"<>|]/g,'_').slice(0,60)||'项目进度';}

const LOCAL_WEB_ASSETS = [
  'index.html','css/style.css','css/cloud.css','css/projects.css','js/app.js','js/cloud-config.js','js/cloud.js',
  'libs/xlsx.full.min.js','libs/exceljs.min.js','libs/supabase.min.js'
];

function localWebFolderName(){const d=new Date();return '项目进度管理-本地网页版-'+dateStamp()+'_'+String(d.getHours()).padStart(2,'0')+String(d.getMinutes()).padStart(2,'0')+String(d.getSeconds()).padStart(2,'0');}
function safeStateScript(){return JSON.stringify(serializeWorkspace()).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');}
function injectLocalWebState(html){const marker='<script src="js/app.js"></script>';if(!html.includes(marker))throw new Error('网页入口中未找到应用脚本标记');const scriptEnd='</scr'+'ipt>';const injected='<script>window.__LOCAL_WEB_MODE__=true;window.__LOCAL_WEB_INITIAL_STATE__='+safeStateScript()+';'+scriptEnd+'\n  '+marker;return html.replace(marker,function(){return injected;});}
async function fetchLocalWebAsset(path,asText){const response=await fetch(new URL(path,window.location.href).href,{cache:'no-store'});if(!response.ok)throw new Error('读取 '+path+' 失败（HTTP '+response.status+'）');return asText?response.text():response.arrayBuffer();}
async function writeDirectoryFile(root,path,data){const parts=path.split('/');const fileName=parts.pop();let directory=root;for(const part of parts)directory=await directory.getDirectoryHandle(part,{create:true});const file=await directory.getFileHandle(fileName,{create:true});const writable=await file.createWritable();try{await writable.write(data);}finally{await writable.close();}}
async function buildStandaloneLocalWeb(){let html=injectLocalWebState(await fetchLocalWebAsset('index.html',true));for(const path of ['css/style.css','css/cloud.css','css/projects.css']){const css=await fetchLocalWebAsset(path,true);const style='<style data-local-source="'+path+'">\n'+css+'\n</style>';html=html.replace('<link rel="stylesheet" href="'+path+'">',function(){return style;});}const scriptEnd='</scr'+'ipt>';for(const path of ['libs/xlsx.full.min.js','libs/exceljs.min.js','libs/supabase.min.js','js/app.js','js/cloud-config.js','js/cloud.js']){const code=(await fetchLocalWebAsset(path,true)).replace(/<\/script/gi,'<\\/script');const inline='<script data-local-source="'+path+'">\n'+code+'\n'+scriptEnd;html=html.replace('<script src="'+path+'"></script>',function(){return inline;});}return html;}
async function saveStandaloneLocalWeb(){const html=await buildStandaloneLocalWeb();const fileName=localWebFolderName()+'.html';if(window.showSaveFilePicker){const handle=await window.showSaveFilePicker({suggestedName:fileName,types:[{description:'本地网页版',accept:{'text/html':['.html']}}]});const writable=await handle.createWritable();try{await writable.write(html);}finally{await writable.close();}}else downloadBlob(new Blob([html],{type:'text/html;charset=utf-8'}),fileName);showToast('本地网页版已保存','双击保存的 HTML 文件即可使用；全部项目类别和任务数据已经包含在文件中。','success');updateStatus('本地网页版已保存');}
async function saveLocalWebVersion(){
  if(location.protocol==='file:')return showToast('当前已经是本地网页版','直接继续使用即可，任务会自动保存在当前浏览器中。','success');
  updateStatus('请选择保存位置');
  try{
    if(!window.showDirectoryPicker){await saveStandaloneLocalWeb();return;}
    const parent=await window.showDirectoryPicker({mode:'readwrite'});
    const folderName=localWebFolderName();const folder=await parent.getDirectoryHandle(folderName,{create:true});updateStatus('正在生成本地网页版…');
    for(const path of LOCAL_WEB_ASSETS){let content=await fetchLocalWebAsset(path,path==='index.html');if(path==='index.html')content=injectLocalWebState(content);await writeDirectoryFile(folder,path,content);}
    await writeDirectoryFile(folder,'全部项目类别数据.gantt',JSON.stringify(serializeWorkspace(),null,2));
    await writeDirectoryFile(folder,'使用说明.txt','项目进度管理 V'+APP_VERSION+' 多项目本地网页版\r\n\r\n1. 双击 index.html 即可打开。\r\n2. 底部标签用于切换项目；点击“＋”新增，点击标签右侧“⋯”改名、复制、移动或删除。\r\n3. 全部项目共用相同列结构，各项目任务内容互相独立。\r\n4. 全部项目和任务会自动保存在当前浏览器，也可保存为“全部项目类别数据.gantt”。\r\n5. Excel 导入、导出只处理当前项目。\r\n6. 云端登录与多人同步需要连接互联网。\r\n');
    showToast('本地网页版已保存','已生成文件夹“'+folderName+'”。双击其中的 index.html 即可使用。','success');updateStatus('本地网页版已保存');
  }catch(error){if(error&&error.name==='AbortError'){updateStatus('已取消保存本地网页版');return;}showToast('保存本地网页版失败','原因：'+(error&&error.message?error.message:'未知错误')+'。请使用最新版 Chrome 或 Edge，并重新选择有写入权限的文件夹。','error');updateStatus('保存本地网页版失败');}
}

function importExcelFile(file) {
  if(typeof XLSX==='undefined')return showToast('导入失败','Excel 读取组件没有加载，请确认 libs/xlsx.full.min.js 文件存在。','error');
  const reader=new FileReader();reader.onload=function(event){try{const workbook=XLSX.read(new Uint8Array(event.target.result),{type:'array'});pendingImport=parseWorkbook(workbook);renderImportPreview(pendingImport,file.name);openModal('importModal');}catch(error){pendingImport=null;showToast('Excel 导入校验失败',error.message+'。原项目数据保持不变。','error');updateStatus('Excel 导入失败');}};reader.onerror=function(){showToast('Excel 读取失败','浏览器无法读取所选文件，请检查文件权限或重新选择。','error');};reader.readAsArrayBuffer(file);
}

function parseWorkbook(workbook) {
  const taskSheet=workbook.Sheets['任务数据']||workbook.Sheets[workbook.SheetNames[0]];if(!taskSheet)throw new Error('工作簿中没有可读取的工作表');const matrix=XLSX.utils.sheet_to_json(taskSheet,{header:1,defval:''});if(matrix.length<2)throw new Error('“任务数据”没有任务行');const headers=matrix[0].map(function(v){return String(v).trim();});
  let columns;const configSheet=workbook.Sheets['列配置'];if(configSheet){const rows=XLSX.utils.sheet_to_json(configSheet,{defval:''});columns=rows.map(function(row,index){let options=[];try{options=row['选项(JSON)']?JSON.parse(row['选项(JSON)']):[];}catch(error){throw new Error('“列配置”第 '+(index+2)+' 行的选项不是有效 JSON');}return{id:String(row['字段ID']||''),title:String(row['显示名称']||'').trim(),type:String(row['类型']||'text'),width:clampNumber(row['宽度(px)']||140,55,600),options:Array.isArray(options)?options.map(String):[],visible:String(row['是否显示'])!=='否',system:String(row['系统字段'])==='是',required:String(row['字段ID'])==='name',order:Number(row['顺序'])||index+1};}).filter(function(c){return c.id&&c.title;}).sort(function(a,b){return a.order-b.order;}).map(function(c){delete c.order;return c;});}
  if(!columns||!columns.length){columns=defaultColumns();const known=new Set(['任务ID','父任务ID','序号','层级','任务名称','具体内容','状态','进度']);headers.forEach(function(title){if(title&&!known.has(title))columns.push({id:'custom_'+Math.random().toString(36).slice(2),title:title,type:'text',width:150,visible:true,system:false,options:[]});});}
  const requiredIds=['name','detail','status','progress'];requiredIds.forEach(function(id){if(!columns.some(function(c){return c.id===id;})){const base=defaultColumns().find(function(c){return c.id===id;});columns.push(base);}});if(!columns.some(function(c){return c.id==='seq';}))columns.unshift(defaultColumns()[0]);
  const titleIndex={};headers.forEach(function(title,index){if(titleIndex[title]!==undefined)throw new Error('“任务数据”第 1 行存在重复列名“'+title+'”');titleIndex[title]=index;});
  const baseNames={name:'任务名称',detail:'具体内容',status:'状态',progress:'进度'};requiredIds.forEach(function(id){const column=columns.find(function(c){return c.id===id;});if(titleIndex[column.title]===undefined&&titleIndex[baseNames[id]]===undefined)throw new Error('“任务数据”缺少必要列“'+column.title+'”');});
  const taskIdIndex=titleIndex['任务ID'];const parentIndex=titleIndex['父任务ID'];const sequenceIndex=titleIndex['序号'];const levelIndex=titleIndex['层级'];const parsed=[];const rawIds=new Set();
  for(let rowIndex=1;rowIndex<matrix.length;rowIndex++){
    const row=matrix[rowIndex];if(!row||row.every(function(v){return String(v).trim()==='';}))continue;const excelRow=rowIndex+1;const idRaw=taskIdIndex===undefined?String(parsed.length+1):String(row[taskIdIndex]||parsed.length+1).trim();if(rawIds.has(idRaw))throw new Error('“任务数据”第 '+excelRow+' 行的任务ID“'+idRaw+'”重复');rawIds.add(idRaw);
    function columnValue(id){const column=columns.find(function(c){return c.id===id;});const index=titleIndex[column.title]!==undefined?titleIndex[column.title]:titleIndex[baseNames[id]];return row[index];}
    const name=String(columnValue('name')||'').trim();if(!name)throw new Error('“任务数据”第 '+excelRow+' 行的“任务名称”为空');const status=String(columnValue('status')||'未开始').trim();if(!STATUS_OPTIONS.includes(status))throw new Error('“任务数据”第 '+excelRow+' 行的“状态”为“'+status+'”，不在允许选项中');const progress=Number(columnValue('progress'));if(!Number.isFinite(progress)||progress<0||progress>100)throw new Error('“任务数据”第 '+excelRow+' 行的“进度”必须是 0 到 100');const values={};columns.filter(function(c){return !c.system;}).forEach(function(column){const index=titleIndex[column.title];let value=index===undefined?'':row[index];if(column.type==='number'&&value!==''){value=Number(value);if(!Number.isFinite(value))throw new Error('“任务数据”第 '+excelRow+' 行的“'+column.title+'”必须是数字');}if(column.type==='checkbox')value=['是','true','1','√'].includes(String(value).toLowerCase());if(column.type==='select'&&value!==''&&!column.options.includes(String(value)))throw new Error('“任务数据”第 '+excelRow+' 行的“'+column.title+'”值“'+value+'”不在下拉选项中');values[column.id]=value;});
    parsed.push({rawId:idRaw,rawParent:parentIndex===undefined?'':String(row[parentIndex]||'').trim(),sequence:sequenceIndex===undefined?'':String(row[sequenceIndex]||'').trim(),level:levelIndex===undefined?'':Number(row[levelIndex]),name:name,detail:String(columnValue('detail')||''),status:status,progress:progress,values:values,excelRow:excelRow});
  }
  if(!parsed.length)throw new Error('“任务数据”中没有有效任务');const idMap=new Map();parsed.forEach(function(item,index){idMap.set(item.rawId,index+1);});const sequenceMap=new Map();parsed.forEach(function(item,index){if(item.sequence)sequenceMap.set(item.sequence,index+1);});const tasks=[];const siblingCounts=new Map();
  parsed.forEach(function(item,index){let parentId=null;if(item.rawParent){if(!idMap.has(item.rawParent))throw new Error('“任务数据”第 '+item.excelRow+' 行的父任务ID“'+item.rawParent+'”不存在');parentId=idMap.get(item.rawParent);}else if(item.sequence&&item.sequence.includes('.')){const parentSeq=item.sequence.split('.').slice(0,-1).join('.');if(!sequenceMap.has(parentSeq))throw new Error('“任务数据”第 '+item.excelRow+' 行的序号“'+item.sequence+'”找不到父级序号“'+parentSeq+'”');parentId=sequenceMap.get(parentSeq);}const key=String(parentId);const sort=(siblingCounts.get(key)||0)+1;siblingCounts.set(key,sort);tasks.push({id:index+1,parentId:parentId,sort:sort,expanded:true,name:item.name,detail:item.detail,status:item.status,progress:item.progress,values:item.values});});
  const taskMap=new Map(tasks.map(function(task){return[task.id,task];}));tasks.forEach(function(task){const seen=new Set([task.id]);let parentId=task.parentId;while(parentId!==null){if(seen.has(parentId))throw new Error('“任务数据”第 '+parsed[task.id-1].excelRow+' 行形成了循环父子关系');seen.add(parentId);const parent=taskMap.get(parentId);if(!parent)throw new Error('“任务数据”第 '+parsed[task.id-1].excelRow+' 行引用了不存在的父任务');parentId=parent.parentId;}});
  const tempState=state;state={tasks:tasks};try{tasks.forEach(function(task){if(taskDepth(task.id)>MAX_DEPTH)throw new Error('“任务数据”第 '+parsed[task.id-1].excelRow+' 行超过四级任务限制');});}finally{state=tempState;}
  return {newState:normalizeState({version:2,appVersion:APP_VERSION,nextId:tasks.length+1,columns:columns,tasks:tasks,ui:{depth:4,chartVisible:true,panelWidth:58,filters:{status:[]},chartLinks:{}}}),count:tasks.length,customCount:columns.filter(function(c){return !c.system;}).length,preview:tasks.slice(0,12)};
}

function renderImportPreview(result,fileName) {document.getElementById('importSummary').textContent='文件：'+fileName+'。识别到 '+result.count+' 项任务、'+result.customCount+' 个自定义列。确认后才会替换当前项目，取消不会修改任何数据。';const root=document.getElementById('importPreview');root.innerHTML='';const table=document.createElement('table');const thead=document.createElement('thead');const hr=document.createElement('tr');['序号','任务名称','具体内容','状态','进度'].forEach(function(h){const th=document.createElement('th');th.textContent=h;hr.appendChild(th);});thead.appendChild(hr);table.appendChild(thead);const body=document.createElement('tbody');const old=state;state=result.newState;const numbers=numberMap();result.preview.forEach(function(task){const tr=document.createElement('tr');[numbers.get(task.id),task.name,task.detail,effectiveStatus(task),effectiveProgress(task)+'%'].forEach(function(v){const td=document.createElement('td');td.textContent=v;tr.appendChild(td);});body.appendChild(tr);});state=old;table.appendChild(body);root.appendChild(table);}

function confirmImport() {if(!pendingImport)return;pushUndo();setCurrentState(pendingImport.newState,true);pendingImport=null;selectedIds.clear();closeModal('importModal');markChanged('Excel 导入成功');renderAll();showToast('导入成功','已替换当前项目的任务；Excel 列结构已同步到全部项目标签。','success');}

async function saveProject(saveAs,silent) {const data=serializeWorkspace();if(window.electronAPI){try{const result=saveAs||!currentFilePath?await window.electronAPI.saveFileAs(data):await window.electronAPI.saveFile(currentFilePath,data);if(result.success){currentFilePath=result.filePath;setSaveLabel('已保存');if(!silent)showToast('项目类别工作簿已保存',result.filePath,'success');}else if(!result.canceled)showToast('保存失败','原因：'+(result.error||'未知错误'),'error');}catch(error){showToast('保存失败','原因：'+error.message,'error');}}else{downloadBlob(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),'项目类别工作簿_'+dateStamp()+'.gantt');setSaveLabel('已下载全部项目类别');}}

function openProject() {if(window.electronAPI){window.electronAPI.openFile().then(handleOpenedProject);}else{const input=document.createElement('input');input.type='file';input.accept='.gantt,.json';input.onchange=function(){const file=input.files[0];if(!file)return;const reader=new FileReader();reader.onload=function(){try{applyOpenedData(JSON.parse(reader.result),null,file.name);}catch(error){showToast('打开失败','项目文件不是有效数据：'+error.message,'error');}};reader.readAsText(file);};input.click();}}
function handleOpenedProject(result){if(result&&result.success)applyOpenedData(result.data,result.filePath,result.fileName);else if(result&&!result.canceled)showToast('打开失败','原因：'+(result.error||'未知错误'),'error');}
function applyOpenedData(data,path,name){workspace=normalizeWorkspace(data);state=activeProject().state;resetProjectInteraction();currentFilePath=path||null;selectedIds.clear();saveLocal();renderAll();showToast('项目工作簿已打开',name||'全部项目标签和数据已载入','success');}
function newProject(){const project=activeProject();if(!confirm('清空当前项目“'+project.name+'”的全部任务吗？公共列结构和其他项目不会改变。'))return;pushUndo();setCurrentState(createEmptyState(workspace.columns),false);selectedIds.clear();markChanged('已清空当前项目“'+project.name+'”');renderAll();}

function startPanelResize(event){event.preventDefault();const workspace=document.getElementById('workspace');const handle=document.getElementById('panelResize');handle.classList.add('dragging');function move(e){const rect=workspace.getBoundingClientRect();state.ui.panelWidth=Math.round(clampNumber((e.clientX-rect.left)/rect.width*100,35,76)*10)/10;document.getElementById('tablePanel').style.width=state.ui.panelWidth+'%';}function up(){document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);handle.classList.remove('dragging');markChanged('已调整表格与状态图宽度');}document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);}

function initElectronMenu() {if(!window.electronAPI)return;window.electronAPI.onMenuNew(newProject);window.electronAPI.onMenuOpen(openProject);window.electronAPI.onMenuSave(function(){saveProject(false,false);});window.electronAPI.onMenuSaveAs(function(){saveProject(true,false);});window.electronAPI.onMenuOpenFile(function(path){window.electronAPI.openFileByPath(path).then(handleOpenedProject);});window.electronAPI.onMenuImport(function(){document.getElementById('excelInput').click();});window.electronAPI.onMenuExport(exportExcel);window.electronAPI.onMenuAddTask(addRootTask);window.electronAPI.onMenuAddChild(function(){const roots=selectedRootTasks();if(roots.length===1)addChildTask(roots[0].id);else showToast('请选择一个父任务','也可以直接点击任务行中的“＋”。');});window.electronAPI.onMenuDelete(deleteSelected);window.electronAPI.onMenuExpand(expandAll);window.electronAPI.onMenuCollapse(collapseAll);if(window.electronAPI.onMenuToggleChart)window.electronAPI.onMenuToggleChart(function(){pushUndo();state.ui.chartVisible=!state.ui.chartVisible;markChanged(state.ui.chartVisible?'状态图已显示':'状态图已隐藏');renderWorkspace();});window.electronAPI.onMenuUndo(undo);window.electronAPI.onMenuRedo(redo);}

function bindEvents() {
  document.getElementById('btnNew').onclick=newProject;document.getElementById('btnOpen').onclick=openProject;document.getElementById('btnSave').onclick=function(){saveProject(false,false);};document.getElementById('btnSaveAs').onclick=saveLocalWebVersion;document.getElementById('btnImport').onclick=function(){document.getElementById('excelInput').click();};document.getElementById('btnExport').onclick=exportExcel;
  document.getElementById('btnAddRoot').onclick=addRootTask;document.getElementById('btnDelete').onclick=deleteSelected;document.getElementById('btnPromote').onclick=promoteSelected;document.getElementById('btnDemote').onclick=demoteSelected;document.getElementById('btnMoveUp').onclick=function(){moveSelection(-1);};document.getElementById('btnMoveDown').onclick=function(){moveSelection(1);};document.getElementById('btnMoveTo').onclick=openMoveModal;document.getElementById('btnConfirmMove').onclick=confirmMoveSelected;document.getElementById('batchStatus').addEventListener('change',function(){batchSetStatus(this.value);});
  document.getElementById('btnAddColumn').onclick=function(){openColumnModal(null);};document.getElementById('btnManageColumns').onclick=openColumnManager;document.getElementById('btnSaveColumn').onclick=saveColumn;document.getElementById('columnType').onchange=toggleColumnOptions;document.getElementById('btnConfirmRename').onclick=confirmRenameColumn;document.getElementById('btnConfirmParentStatus').onclick=confirmParentStatus;document.getElementById('btnUndo').onclick=undo;document.getElementById('btnRedo').onclick=redo;
  document.querySelectorAll('.depth-btn').forEach(function(button){button.onclick=function(){setDepth(Number(button.dataset.depth));};});document.getElementById('btnExpandAll').onclick=expandAll;document.getElementById('btnCollapseAll').onclick=collapseAll;document.getElementById('btnClearFilters').onclick=clearFilters;
  document.getElementById('chartVisible').onchange=function(){pushUndo();state.ui.chartVisible=this.checked;markChanged(this.checked?'状态图已显示':'状态图已隐藏');renderWorkspace();};document.getElementById('panelResize').addEventListener('mousedown',startPanelResize);
  document.getElementById('excelInput').onchange=function(){if(this.files&&this.files[0])importExcelFile(this.files[0]);this.value='';};document.getElementById('btnConfirmImport').onclick=confirmImport;
  document.getElementById('btnAddProjectCategory').onclick=openAddProjectCategory;document.getElementById('btnConfirmProjectCategory').onclick=confirmAddProjectCategory;document.getElementById('btnConfirmProjectRename').onclick=confirmProjectRename;
  document.getElementById('projectMenuRename').onclick=function(){openProjectRename(projectMenuTargetId);};document.getElementById('projectMenuDuplicate').onclick=function(){duplicateProjectCategory(projectMenuTargetId);};document.getElementById('projectMenuLeft').onclick=function(){moveProjectCategory(projectMenuTargetId,-1);};document.getElementById('projectMenuRight').onclick=function(){moveProjectCategory(projectMenuTargetId,1);};document.getElementById('projectMenuDelete').onclick=function(){deleteProjectCategory(projectMenuTargetId);};
  document.querySelectorAll('[data-close]').forEach(function(button){button.addEventListener('click',function(){closeModal(button.dataset.close);});});document.querySelectorAll('.modal').forEach(function(modal){modal.addEventListener('mousedown',function(event){if(event.target===modal)closeModal(modal.id);});});
  document.addEventListener('click',function(event){const menu=document.getElementById('projectTabMenu');if(menu.classList.contains('open')&&!menu.contains(event.target)&&!event.target.closest('.project-tab-more'))closeProjectTabMenu();});
  document.addEventListener('keydown',function(event){if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();}else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();redo();}else if(event.key==='Escape'){closeProjectTabMenu();document.querySelectorAll('.modal.open').forEach(function(modal){closeModal(modal.id);});}});
  const tableScroll=document.getElementById('tableScroll'),chartScroll=document.getElementById('chartScroll');tableScroll.addEventListener('scroll',function(){if(scrollSyncing)return;scrollSyncing=true;chartScroll.scrollTop=tableScroll.scrollTop;scrollSyncing=false;});chartScroll.addEventListener('scroll',function(){if(scrollSyncing)return;scrollSyncing=true;tableScroll.scrollTop=chartScroll.scrollTop;scrollSyncing=false;});
}

function init() {
  workspace=loadLocalWorkspace();state=activeProject().state;const batch=document.getElementById('batchStatus');const parentStatus=document.getElementById('parentStatusSelect');STATUS_OPTIONS.forEach(function(status){appendOption(batch,status,status);appendOption(parentStatus,status,status);});bindEvents();initElectronMenu();renderAll();updateStatus('准备就绪 — V'+APP_VERSION+' · '+activeProject().name);setSaveLabel('已自动保存');
  window.ProjectProgressApp={getState:function(){return serializeWorkspace();},replaceState:function(nextState,message){workspace=normalizeWorkspace(nextState);state=activeProject().state;resetProjectInteraction();saveLocal();renderAll();updateStatus(message||'已载入云端项目工作簿');},showToast:showToast,setSaveLabel:setSaveLabel,updateStatus:updateStatus,effectiveStatus:function(id){return effectiveStatus(byId(id));},effectiveProgress:function(id){return effectiveProgress(byId(id));},numberMap:function(){return Object.fromEntries(numberMap());},visibleRows:function(){return visibleRows().map(function(r){return{id:r.task.id,context:r.context};});},reset:function(){setCurrentState(createEmptyState(workspace.columns),false);selectedIds.clear();saveLocal();renderAll();}};
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
