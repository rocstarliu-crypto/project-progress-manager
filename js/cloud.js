'use strict';

(function () {
  const PROJECT_KEY = 'project-progress-manager-v1.2.0-cloud-project';
  const DRAFT_KEY_PREFIX = 'project-progress-manager-v1.4.0-cloud-draft-';
  const config = window.PROJECT_CLOUD_CONFIG || {};
  let recoveryIntent = /(?:^|[?#&])type=recovery(?:&|$)/i.test(location.hash + '&' + location.search);
  let app = null;
  let client = null;
  let session = null;
  let authView = 'login';
  let projects = [];
  let currentProject = null;
  let currentRevision = 0;
  let channel = null;
  let saveTimer = null;
  let saveInFlight = false;
  let saveQueued = false;
  let dirty = false;
  let applyingRemote = false;
  let conflictOpen = false;
  let draftStorageWarned = false;
  const el = {};
  const byId = function (id) { return document.getElementById(id); };

  function cacheElements() {
    ['cloudConnection','btnCloudProject','btnProjectHistoryHeader','cloudUser','btnCloudLogout','cloudModal','cloudAuthView','cloudPasswordResetView','cloudNewPasswordView','cloudProjectsView','cloudEmail','cloudPassword','btnCloudRegister','btnCloudLogin','btnCloudForgotPassword','cloudPasswordResetEmail','btnCloudSendPasswordReset','btnCloudBackToLogin','cloudNewPassword','cloudNewPasswordConfirm','btnCloudUpdatePassword','cloudAccountEmail','btnLoginHistory','btnRefreshProjects','cloudCurrentProject','cloudCurrentProjectName','cloudShareCode','btnCopyShareCode','cloudProjectSelect','cloudNewProjectName','btnCreateCloudProject','cloudJoinCode','btnJoinCloudProject','cloudActivity','projectHistoryModal','projectHistorySubtitle','projectHistoryList','btnRefreshProjectHistory','loginHistoryModal','loginHistoryList','btnRefreshLoginHistory'].forEach(function (id) { el[id] = byId(id); });
  }

  function toast(title, detail, type) { if (app && app.showToast) app.showToast(title, detail, type); }
  function setActivity(message) { if (el.cloudActivity) el.cloudActivity.textContent = message; }
  function setConnection(kind, label) {
    if (!el.cloudConnection) return;
    el.cloudConnection.className = 'cloud-connection ' + kind;
    el.cloudConnection.querySelector('span').textContent = label;
  }
  function openCloudModal() { el.cloudModal.classList.add('open'); el.cloudModal.setAttribute('aria-hidden', 'false'); renderAccountState(); }
  function openModal(element) { if (!element) return; element.classList.add('open'); element.setAttribute('aria-hidden', 'false'); }
  function closeModal(element) { if (!element) return; element.classList.remove('open'); element.setAttribute('aria-hidden', 'true'); }
  function draftKey(projectId) { return DRAFT_KEY_PREFIX + projectId; }
  function saveDraftSnapshot(snapshot) {
    if (!currentProject || !app) return;
    try {
      localStorage.setItem(draftKey(currentProject.project_id), JSON.stringify({data:snapshot || app.getState(), baseRevision:currentRevision, savedAt:new Date().toISOString()}));
      draftStorageWarned = false;
    } catch (error) {
      if (!draftStorageWarned) toast('本机草稿保护失败', '浏览器存储空间不足或不可用：' + humanError(error) + '。请立即点击“保存”下载备份。', 'error');
      draftStorageWarned = true;
    }
  }
  function readDraft(projectId) {
    try {
      const raw = localStorage.getItem(draftKey(projectId));
      if (!raw) return null;
      const draft = JSON.parse(raw);
      return draft && draft.data ? draft : null;
    } catch (error) { return null; }
  }
  function clearDraft(projectId) { try { localStorage.removeItem(draftKey(projectId)); } catch (error) {} }
  function formatDateTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString('zh-CN', {hour12:false}); }
  function currentRegion() {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const labels = {'Asia/Shanghai':'中国·北京时间','Asia/Hong_Kong':'中国·香港','Asia/Macau':'中国·澳门','Asia/Taipei':'中国·台北','Asia/Singapore':'新加坡','Asia/Tokyo':'日本·东京','America/Los_Angeles':'美国·西部','America/New_York':'美国·东部','Europe/London':'英国·伦敦'};
    return labels[zone] ? labels[zone] + '（' + zone + '）' : (zone || navigator.language || '未知区域');
  }
  function enterPasswordRecovery(nextSession, notifyUser) {
    if (nextSession) session = nextSession;
    recoveryIntent = false;
    authView = 'reset-password';
    openCloudModal();
    if (notifyUser) toast('请设置新密码', '邮箱验证已通过，请在这里输入并保存新密码。', 'success');
    setTimeout(function () { if (el.cloudNewPassword) el.cloudNewPassword.focus(); }, 0);
  }
  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) { button.dataset.originalText = button.textContent; button.textContent = busyText || '处理中…'; button.disabled = true; }
    else { button.textContent = button.dataset.originalText || button.textContent; button.disabled = false; }
  }

  function humanError(error) {
    const message = String(error && (error.message || error.error_description) || error || '未知错误');
    if (/Invalid login credentials/i.test(message)) return '邮箱或密码不正确，或邮箱尚未确认。';
    if (/Email not confirmed/i.test(message)) return '邮箱尚未确认，请先打开确认邮件中的链接。';
    if (/User already registered/i.test(message)) return '该邮箱已经注册，请直接登录。';
    if (/Password should be/i.test(message)) return '密码长度不足，请至少输入 6 位。';
    if (/Email rate limit exceeded|rate limit/i.test(message)) return '邮件发送过于频繁，请稍后再试。';
    if (/redirect/i.test(message)) return '恢复链接地址未获允许。请在 Supabase 的 URL Configuration 中加入当前网站地址。';
    if (/SHARE_CODE_NOT_FOUND/i.test(message)) return '没有找到该共享码，请让项目所有者重新复制。';
    if (/NOT_AUTHENTICATED/i.test(message)) return '登录状态已失效，请重新登录。';
    if (/NOT_AUTHORIZED/i.test(message)) return '当前账号没有编辑这个项目的权限。';
    if (/PGRST202|project_state_history|list_project_history|restore_collaboration_project|record_login_history|list_login_history|Could not find the function/i.test(message)) return '云数据库尚未执行 V1.4.0 升级脚本，历史记录功能暂不可用。';
    return message;
  }

  function renderAccountState() {
    const loggedIn = Boolean(session && session.user);
    const resetting = authView === 'reset-password';
    el.cloudAuthView.classList.toggle('hidden', loggedIn || authView !== 'login');
    el.cloudPasswordResetView.classList.toggle('hidden', loggedIn || authView !== 'reset-request');
    el.cloudNewPasswordView.classList.toggle('hidden', !resetting);
    el.cloudProjectsView.classList.toggle('hidden', !loggedIn || resetting);
    el.cloudUser.classList.toggle('hidden', !loggedIn);
    el.btnCloudLogout.classList.toggle('hidden', !loggedIn || resetting);
    if (el.btnProjectHistoryHeader) el.btnProjectHistoryHeader.classList.toggle('hidden', !loggedIn || resetting || !currentProject);
    if (resetting) {
      el.btnCloudProject.textContent = '设置新密码';
      setConnection('signed-in', '设置新密码');
      return;
    }
    if (!loggedIn) {
      el.cloudUser.textContent = '';
      el.btnCloudProject.textContent = '登录云端';
      setConnection('local', '仅本机');
      return;
    }
    const email = session.user.email || '已登录账号';
    el.cloudUser.textContent = email;
    el.cloudUser.title = email;
    el.cloudAccountEmail.textContent = email;
    el.btnCloudProject.textContent = currentProject ? currentProject.name : '选择云端项目';
    if (currentProject) setConnection(dirty ? 'syncing' : 'online', dirty ? '等待同步' : '云端已同步');
    else setConnection('signed-in', '已登录');
  }

  function renderProjects() {
    const select = el.cloudProjectSelect;
    select.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = projects.length ? '请选择项目' : '暂无项目';
    select.appendChild(empty);
    projects.forEach(function (project) {
      const option = document.createElement('option');
      option.value = project.project_id;
      option.textContent = project.name + '（' + (project.role === 'owner' ? '所有者' : project.role === 'editor' ? '可编辑' : '只读') + '）';
      select.appendChild(option);
    });
    select.value = currentProject ? currentProject.project_id : '';
    const hasCurrent = Boolean(currentProject);
    el.cloudCurrentProject.classList.toggle('hidden', !hasCurrent);
    if (hasCurrent) {
      el.cloudCurrentProjectName.textContent = currentProject.name;
      el.cloudShareCode.textContent = currentProject.share_code;
      el.btnCloudProject.textContent = currentProject.name;
    }
  }

  async function refreshProjects(autoLoad) {
    if (!session) return;
    setActivity('正在读取项目列表…');
    const result = await client.rpc('list_collaboration_projects');
    if (result.error) throw result.error;
    projects = Array.isArray(result.data) ? result.data : [];
    if (currentProject) currentProject = projects.find(function (p) { return p.project_id === currentProject.project_id; }) || null;
    renderProjects();
    const remembered = localStorage.getItem(PROJECT_KEY);
    if (autoLoad && !currentProject && remembered && projects.some(function (p) { return p.project_id === remembered; })) {
      await selectProject(remembered, true);
      return;
    }
    setActivity(projects.length ? '请选择要进入的云端项目，或新建一个项目。' : '当前账号还没有协作项目，可新建或输入共享码加入。');
    renderAccountState();
  }

  async function fetchSnapshot(projectId) {
    const result = await client.from('project_state').select('data,revision,updated_by,updated_at').eq('project_id', projectId).single();
    if (result.error) throw result.error;
    return result.data;
  }

  function applySnapshot(snapshot, message) {
    if (!snapshot || !snapshot.data) return;
    applyingRemote = true;
    try {
      currentRevision = Number(snapshot.revision || 0);
      dirty = false;
      app.replaceState(snapshot.data, message || '已载入云端项目');
      app.setSaveLabel('云端已同步');
      setConnection('online', '云端已同步');
    } finally { applyingRemote = false; }
  }

  async function selectProject(projectId, skipConfirm) {
    const next = projects.find(function (p) { return p.project_id === projectId; });
    if (!next) return;
    if (!skipConfirm && currentProject && currentProject.project_id !== projectId && dirty && !confirm('当前页面还有尚未同步的更改。确定切换并载入另一个云端项目吗？')) { renderProjects(); return; }
    setConnection('syncing', '正在载入');
    setActivity('正在载入“' + next.name + '”…');
    unsubscribe();
    const snapshot = await fetchSnapshot(projectId);
    currentProject = next;
    localStorage.setItem(PROJECT_KEY, projectId);
    const localDraft = readDraft(projectId);
    if (localDraft) {
      const savedAt = formatDateTime(localDraft.savedAt);
      const restoreLocal = confirm('发现这个项目有一份尚未同步的本机草稿（' + savedAt + '）。\n\n点击“确定”：恢复本机草稿并继续同步。\n点击“取消”：暂时载入云端版本，本机草稿仍会保留。');
      if (restoreLocal) {
        applyingRemote = true;
        try {
          currentRevision = Number(snapshot.revision || 0);
          dirty = false;
          app.replaceState(localDraft.data, '已恢复尚未同步的本机草稿');
        } finally { applyingRemote = false; }
        dirty = true;
        scheduleSave(true);
        toast('本机草稿已恢复', '系统正在把草稿保存为新的云端版本。', 'success');
      } else {
        applySnapshot(snapshot, '已载入云端项目“' + next.name + '”');
        toast('本机草稿仍然保留', '下次进入该项目时仍可选择恢复；继续编辑云端版本会替换这份草稿。');
      }
    } else applySnapshot(snapshot, '已进入云端项目“' + next.name + '”');
    subscribe(projectId);
    renderProjects();
    renderAccountState();
    setActivity('实时协作已连接。其他成员保存后，本页面会自动收到更新。');
  }

  function unsubscribe() { if (channel && client) client.removeChannel(channel); channel = null; }
  function subscribe(projectId) {
    unsubscribe();
    channel = client.channel('project-state-' + projectId)
      .on('postgres_changes', {event:'UPDATE', schema:'public', table:'project_state', filter:'project_id=eq.' + projectId}, function (payload) { handleRemoteUpdate(payload.new); })
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') setConnection(dirty ? 'syncing' : 'online', dirty ? '等待同步' : '云端已同步');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setConnection('error', '实时连接异常');
      });
  }

  function handleRemoteUpdate(next) {
    if (!currentProject || next.project_id !== currentProject.project_id) return;
    const revision = Number(next.revision || 0);
    if (revision <= currentRevision) return;
    if (next.updated_by === session.user.id) { currentRevision = revision; return; }
    if (dirty && !conflictOpen) {
      conflictOpen = true;
      const useCloud = confirm('另一位成员刚刚保存了新版本，而你也有尚未同步的修改。\n\n点击“确定”：载入对方的云端版本。\n点击“取消”：保留本机版本并在最新版本上重新提交。');
      conflictOpen = false;
      if (!useCloud) { currentRevision = revision; scheduleSave(true); toast('已保留本机版本', '系统将按你的选择重新提交到云端。'); return; }
    }
    applySnapshot(next, '已收到其他成员的实时更新');
    toast('项目已更新', '已同步另一位成员刚刚保存的内容。', 'success');
  }

  function scheduleSave(immediate) {
    if (applyingRemote || !session || !currentProject) return;
    dirty = true;
    saveDraftSnapshot();
    setConnection('syncing', '等待同步');
    app.setSaveLabel('等待云端同步');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToCloud, immediate ? 0 : 900);
  }

  async function saveToCloud() {
    if (!dirty || !session || !currentProject || applyingRemote) return;
    if (saveInFlight) { saveQueued = true; return; }
    saveInFlight = true;
    const snapshot = app.getState();
    saveDraftSnapshot(snapshot);
    setConnection('syncing', '正在同步');
    try {
      const result = await client.rpc('save_collaboration_project', {p_project_id:currentProject.project_id, p_expected_revision:currentRevision, p_data:snapshot});
      if (result.error) throw result.error;
      currentRevision = Number(result.data || currentRevision + 1);
      dirty = false;
      clearDraft(currentProject.project_id);
      app.setSaveLabel('云端已同步');
      setConnection('online', '云端已同步');
      setActivity('最近一次同步成功：' + new Date().toLocaleTimeString());
    } catch (error) {
      if (/CLOUD_VERSION_CONFLICT/i.test(String(error && error.message))) await resolveSaveConflict();
      else {
        dirty = true;
        app.setSaveLabel('云端同步失败，本机已保存');
        setConnection('error', navigator.onLine ? '同步失败' : '网络已断开');
        setActivity('同步失败：' + humanError(error) + '。本机数据仍然保留，恢复网络后再次修改即可重试。');
      }
    } finally {
      saveInFlight = false;
      if (saveQueued) { saveQueued = false; scheduleSave(true); }
    }
  }

  async function resolveSaveConflict() {
    const latest = await fetchSnapshot(currentProject.project_id);
    const useCloud = confirm('保存时发现云端已经被另一位成员更新。\n\n点击“确定”：使用云端最新版本。\n点击“取消”：保留本机内容并覆盖到新版本。');
    if (useCloud) { applySnapshot(latest, '已解决冲突并载入云端最新版本'); toast('冲突已解决', '已采用云端最新版本。', 'success'); }
    else { currentRevision = Number(latest.revision || 0); dirty = true; saveQueued = true; toast('保留本机版本', '正在基于最新版本重新提交。'); }
  }

  async function register() {
    const email = el.cloudEmail.value.trim();
    const password = el.cloudPassword.value;
    if (!email || password.length < 6) return toast('无法注册', '请输入有效邮箱，密码至少 6 位。', 'error');
    setBusy(el.btnCloudRegister, true, '正在注册…');
    try {
      const result = await client.auth.signUp({email:email, password:password, options:{emailRedirectTo:location.origin + location.pathname}});
      if (result.error) throw result.error;
      if (result.data.session) toast('注册成功', '账号已登录，可以创建或加入项目。', 'success');
      else toast('请确认邮箱', '确认邮件已发送。点击邮件中的链接后，再返回网页登录。', 'success');
    } catch (error) { toast('注册失败', humanError(error), 'error'); }
    finally { setBusy(el.btnCloudRegister, false); }
  }

  async function login() {
    const email = el.cloudEmail.value.trim();
    const password = el.cloudPassword.value;
    if (!email || !password) return toast('无法登录', '请填写邮箱和密码。', 'error');
    setBusy(el.btnCloudLogin, true, '正在登录…');
    try {
      const result = await client.auth.signInWithPassword({email:email, password:password});
      if (result.error) throw result.error;
      el.cloudPassword.value = '';
      try { await recordLoginHistory(); }
      catch (historyError) { toast('登录成功，但未记录登录历史', humanError(historyError), 'error'); }
      toast('登录成功', '正在读取你的协作项目。', 'success');
    } catch (error) { toast('登录失败', humanError(error), 'error'); }
    finally { setBusy(el.btnCloudLogin, false); }
  }

  function openPasswordResetRequest() {
    authView = 'reset-request';
    el.cloudPasswordResetEmail.value = el.cloudEmail.value.trim();
    renderAccountState();
    el.cloudPasswordResetEmail.focus();
  }

  function backToLogin() {
    authView = 'login';
    renderAccountState();
    el.cloudEmail.focus();
  }

  function passwordRedirectUrl() { return location.origin + location.pathname; }

  async function sendPasswordReset() {
    const email = el.cloudPasswordResetEmail.value.trim();
    if (!email) return toast('无法发送恢复邮件', '请填写注册邮箱。', 'error');
    setBusy(el.btnCloudSendPasswordReset, true, '正在发送…');
    try {
      const result = await client.auth.resetPasswordForEmail(email, {redirectTo:passwordRedirectUrl()});
      if (result.error) throw result.error;
      el.cloudEmail.value = email;
      authView = 'login';
      renderAccountState();
      toast('恢复邮件已发送', '如该邮箱已注册，请打开邮件中的恢复链接，然后在本网页设置新密码。', 'success');
    } catch (error) { toast('发送恢复邮件失败', humanError(error), 'error'); }
    finally { setBusy(el.btnCloudSendPasswordReset, false); }
  }

  async function updatePassword() {
    const password = el.cloudNewPassword.value;
    const confirmation = el.cloudNewPasswordConfirm.value;
    if (password.length < 6) return toast('无法设置新密码', '新密码至少需要 6 位。', 'error');
    if (password !== confirmation) return toast('无法设置新密码', '两次输入的密码不一致，请重新输入。', 'error');
    setBusy(el.btnCloudUpdatePassword, true, '正在保存…');
    try {
      const result = await client.auth.updateUser({password:password});
      if (result.error) throw result.error;
      el.cloudNewPassword.value = '';
      el.cloudNewPasswordConfirm.value = '';
      authView = 'login';
      if (location.hash) history.replaceState(null, document.title, location.pathname + location.search);
      await handleSession(session, true);
      toast('密码已更新', '新密码已经生效。你已保持登录状态，可以继续使用云端协作。', 'success');
    } catch (error) { toast('设置新密码失败', humanError(error), 'error'); }
    finally { setBusy(el.btnCloudUpdatePassword, false); }
  }

  async function logout() {
    if (dirty && !confirm('当前仍有等待同步的修改，确定退出云端账号吗？本机副本会继续保留。')) return;
    await client.auth.signOut();
  }

  async function createProject() {
    const name = el.cloudNewProjectName.value.trim();
    if (!name) return toast('不能创建项目', '请输入项目名称。', 'error');
    setBusy(el.btnCreateCloudProject, true, '正在创建…');
    try {
      const result = await client.rpc('create_collaboration_project', {p_name:name, p_initial_data:app.getState()});
      if (result.error) throw result.error;
      el.cloudNewProjectName.value = '';
      await refreshProjects(false);
      await selectProject(String(result.data), true);
      toast('云端项目已创建', '可以复制共享码邀请成员。', 'success');
    } catch (error) { toast('创建失败', humanError(error), 'error'); }
    finally { setBusy(el.btnCreateCloudProject, false); }
  }

  async function joinProject() {
    const code = el.cloudJoinCode.value.trim().toUpperCase();
    if (!code) return toast('不能加入项目', '请输入项目共享码。', 'error');
    setBusy(el.btnJoinCloudProject, true, '正在加入…');
    try {
      const result = await client.rpc('join_collaboration_project', {p_share_code:code});
      if (result.error) throw result.error;
      el.cloudJoinCode.value = '';
      await refreshProjects(false);
      await selectProject(String(result.data), true);
      toast('已加入项目', '现在可以和其他成员共同编辑。', 'success');
    } catch (error) { toast('加入失败', humanError(error), 'error'); }
    finally { setBusy(el.btnJoinCloudProject, false); }
  }

  async function copyShareCode() {
    if (!currentProject) return;
    try { await navigator.clipboard.writeText(currentProject.share_code); toast('共享码已复制', '把共享码发给需要加入项目的成员。', 'success'); }
    catch (error) { toast('无法自动复制', '共享码是：' + currentProject.share_code, 'error'); }
  }

  async function recordLoginHistory() {
    const result = await client.rpc('record_login_history', {p_region:currentRegion()});
    if (result.error) throw result.error;
  }

  function renderProjectHistory(rows) {
    el.projectHistoryList.innerHTML = '';
    if (!rows.length) {
      el.projectHistoryList.innerHTML = '<div class="history-empty">当前项目还没有历史版本。</div>';
      return;
    }
    rows.forEach(function (item) {
      const revision = Number(item.revision || 0);
      const current = revision === currentRevision;
      const row = document.createElement('div');
      row.className = 'history-item' + (current ? ' current' : '');
      const time = document.createElement('div');
      time.className = 'history-time';
      const strong = document.createElement('strong');
      strong.textContent = formatDateTime(item.saved_at);
      const small = document.createElement('small');
      small.textContent = current ? '当前使用版本' : '可恢复版本';
      time.append(strong, small);
      const version = document.createElement('span');
      version.textContent = '版本 ' + revision;
      const author = document.createElement('span');
      author.textContent = item.saved_by && session && item.saved_by === session.user.id ? '保存人：我' : '保存人：其他成员';
      const action = item.action === 'restore' ? '历史恢复' : item.action === 'initial' ? '项目创建' : '自动保存';
      author.title = action;
      const button = document.createElement('button');
      button.textContent = current ? '当前版本' : '恢复到此时间';
      button.disabled = current;
      if (!current) {
        button.dataset.historyId = item.history_id;
        button.dataset.historyTime = formatDateTime(item.saved_at);
      }
      row.append(time, version, author, button);
      el.projectHistoryList.appendChild(row);
    });
  }

  async function loadProjectHistory() {
    if (!session || !currentProject) return;
    el.projectHistoryList.innerHTML = '<div class="history-empty">正在读取历史版本…</div>';
    const result = await client.rpc('list_project_history', {p_project_id:currentProject.project_id, p_limit:50});
    if (result.error) {
      el.projectHistoryList.innerHTML = '<div class="history-empty history-error">' + humanError(result.error) + '</div>';
      return;
    }
    renderProjectHistory(Array.isArray(result.data) ? result.data : []);
  }

  async function openProjectHistory() {
    if (!session || !currentProject) {
      openCloudModal();
      return toast('请先选择云端项目', '登录后选择一个云端协作项目，才能查看历史版本。');
    }
    el.projectHistorySubtitle.textContent = '当前项目：' + currentProject.name + '。按保存时间查看，并可恢复到历史版本。';
    openModal(el.projectHistoryModal);
    await loadProjectHistory();
  }

  async function restoreProjectHistory(historyId, historyTime, button) {
    if (!session || !currentProject || !historyId) return;
    if (!confirm('确定把当前项目恢复到 ' + historyTime + ' 吗？\n\n恢复前的当前版本也会保留在历史记录中，可以再次找回。')) return;
    setBusy(button, true, '正在恢复…');
    try {
      const result = await client.rpc('restore_collaboration_project', {p_project_id:currentProject.project_id, p_history_id:historyId, p_expected_revision:currentRevision});
      if (result.error) throw result.error;
      currentRevision = Number(result.data || currentRevision + 1);
      clearDraft(currentProject.project_id);
      const snapshot = await fetchSnapshot(currentProject.project_id);
      applySnapshot(snapshot, '已恢复到 ' + historyTime);
      await loadProjectHistory();
      toast('历史版本已恢复', '恢复前的版本仍然保留，可以随时再次恢复。', 'success');
    } catch (error) {
      toast('恢复失败', humanError(error) + '。当前项目没有被修改。', 'error');
      if (/CLOUD_VERSION_CONFLICT/i.test(String(error && error.message))) await selectProject(currentProject.project_id, true);
    } finally { setBusy(button, false); }
  }

  function renderLoginHistory(rows) {
    el.loginHistoryList.innerHTML = '';
    if (!rows.length) {
      el.loginHistoryList.innerHTML = '<div class="history-empty">当前账号还没有登录历史记录。</div>';
      return;
    }
    rows.forEach(function (item) {
      const row = document.createElement('div');
      row.className = 'history-item login-history-item';
      const time = document.createElement('div');
      time.className = 'history-time';
      const strong = document.createElement('strong');
      strong.textContent = formatDateTime(item.logged_in_at);
      const small = document.createElement('small');
      small.textContent = '登录时间';
      time.append(strong, small);
      const region = document.createElement('span');
      region.textContent = item.region || '未知区域';
      row.append(time, region);
      el.loginHistoryList.appendChild(row);
    });
  }

  async function loadLoginHistory() {
    if (!session) return;
    el.loginHistoryList.innerHTML = '<div class="history-empty">正在读取登录记录…</div>';
    const result = await client.rpc('list_login_history', {p_limit:30});
    if (result.error) {
      el.loginHistoryList.innerHTML = '<div class="history-empty history-error">' + humanError(result.error) + '</div>';
      return;
    }
    renderLoginHistory(Array.isArray(result.data) ? result.data : []);
  }

  async function openLoginHistory() {
    if (!session) {
      openCloudModal();
      return toast('请先登录', '登录后只能查看当前账号自己的登录历史。');
    }
    openModal(el.loginHistoryModal);
    await loadLoginHistory();
  }

  function bindEvents() {
    el.btnCloudProject.addEventListener('click', openCloudModal);
    el.btnCloudLogout.addEventListener('click', logout);
    el.btnCloudRegister.addEventListener('click', register);
    el.btnCloudLogin.addEventListener('click', login);
    el.btnCloudForgotPassword.addEventListener('click', openPasswordResetRequest);
    el.btnCloudSendPasswordReset.addEventListener('click', sendPasswordReset);
    el.btnCloudBackToLogin.addEventListener('click', backToLogin);
    el.btnCloudUpdatePassword.addEventListener('click', updatePassword);
    el.btnRefreshProjects.addEventListener('click', function () { refreshProjects(false).catch(function (error) { toast('刷新失败', humanError(error), 'error'); }); });
    el.cloudProjectSelect.addEventListener('change', function () { if (this.value) selectProject(this.value, false).catch(function (error) { toast('载入失败', humanError(error), 'error'); }); });
    el.btnCreateCloudProject.addEventListener('click', createProject);
    el.btnJoinCloudProject.addEventListener('click', joinProject);
    el.btnCopyShareCode.addEventListener('click', copyShareCode);
    el.btnProjectHistoryHeader.addEventListener('click', function () { openProjectHistory().catch(function (error) { toast('读取历史版本失败', humanError(error), 'error'); }); });
    el.btnLoginHistory.addEventListener('click', function () { openLoginHistory().catch(function (error) { toast('读取登录历史失败', humanError(error), 'error'); }); });
    el.btnRefreshProjectHistory.addEventListener('click', function () { loadProjectHistory().catch(function (error) { toast('刷新失败', humanError(error), 'error'); }); });
    el.btnRefreshLoginHistory.addEventListener('click', function () { loadLoginHistory().catch(function (error) { toast('刷新失败', humanError(error), 'error'); }); });
    el.projectHistoryList.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-history-id]');
      if (button) restoreProjectHistory(button.dataset.historyId, button.dataset.historyTime, button);
    });
    window.addEventListener('online', function () { if (dirty) scheduleSave(true); else if (currentProject) setConnection('online', '云端已同步'); });
    window.addEventListener('offline', function () { if (currentProject) setConnection('error', '网络已断开'); });
    window.addEventListener('beforeunload', function () { if (dirty) saveDraftSnapshot(); });
  }

  async function handleSession(nextSession, autoLoad) {
    session = nextSession;
    if (!session) {
      unsubscribe(); projects = []; currentProject = null; currentRevision = 0; dirty = false;
      localStorage.removeItem(PROJECT_KEY); renderProjects(); renderAccountState(); setActivity('尚未登录。'); return;
    }
    renderAccountState();
    try { await refreshProjects(autoLoad); }
    catch (error) {
      toast('读取项目失败', humanError(error) + '。若数据库刚创建，请先执行随项目附带的 Supabase 初始化脚本。', 'error');
      setConnection('error', '数据库未初始化');
    }
  }

  async function init() {
    app = window.ProjectProgressApp;
    cacheElements(); bindEvents();
    if (!app) {
      setConnection('error', '应用初始化失败');
      return;
    }
    if (!window.supabase || !window.supabase.createClient || !config.url || !config.publishableKey) {
      setConnection('error', '云端组件未载入'); el.btnCloudProject.textContent = '云端暂不可用'; el.btnCloudProject.disabled = true; return;
    }
    client = window.supabase.createClient(config.url, config.publishableKey, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
    client.auth.onAuthStateChange(function (event, nextSession) {
      if (event === 'PASSWORD_RECOVERY' || (recoveryIntent && nextSession)) {
        setTimeout(function () { enterPasswordRecovery(nextSession, true); }, 0);
        return;
      }
      if (authView === 'reset-password' && nextSession) {
        session = nextSession;
        return;
      }
      if ((session && session.access_token) === (nextSession && nextSession.access_token) && event === 'INITIAL_SESSION') return;
      setTimeout(function () { handleSession(nextSession, true); }, 0);
    });
    const result = await client.auth.getSession();
    if (result.error) toast('登录状态读取失败', humanError(result.error), 'error');
    if ((recoveryIntent || authView === 'reset-password') && result.data.session) enterPasswordRecovery(result.data.session, false);
    else if (recoveryIntent) {
      recoveryIntent = false;
      authView = 'login';
      openCloudModal();
      toast('恢复链接无效', '该链接可能已过期或已经使用，请重新点击“忘记密码？”申请恢复邮件。', 'error');
    } else if (authView !== 'reset-password') await handleSession(result.data.session, true);
  }

  window.CloudSync = {
    scheduleSave: scheduleSave,
    isApplyingRemote: function () { return applyingRemote; },
    open: openCloudModal,
    getStatus: function () { return {signedIn:Boolean(session), project:currentProject, revision:currentRevision, dirty:dirty}; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
