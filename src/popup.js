'use strict';

const STORAGE_KEY = 'sigaa_autopreenche_perfis';
const CADASTRO_KEY = 'sigaa_autopreenche_cadastro_modelo';
const RESULT_KEY = 'sigaa_autopreenche_ultimo_resultado';

let toastTimer = null;

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function toast(msg, tipo = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${tipo} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function sendToTab(msg) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) {
        resolve({ ok: false, msg: 'Nenhuma aba ativa.' });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, msg: 'Não consegui acessar o SIGAA nesta aba. Recarregue a página e tente novamente.' });
        } else {
          resolve(resp || { ok: false, msg: 'O SIGAA não respondeu.' });
        }
      });
    });
  });
}

function countFields(perfil) {
  if (!perfil || !perfil.dados) return 0;
  if (Number.isInteger(perfil.fieldCount)) return perfil.fieldCount;
  if (Array.isArray(perfil.dados.campos)) return perfil.dados.campos.length;
  return Object.keys(perfil.dados).filter((key) => !key.startsWith('radio_label__') && !key.startsWith('check_labels__')).length;
}

function countModelAnswers(model) {
  if (!model || !Array.isArray(model.questions)) return 0;
  return model.questions.reduce((sum, q) => {
    const choices = Array.isArray(q.choices) ? q.choices.length : 0;
    return sum + choices + (q.textValue ? 1 : 0);
  }, 0);
}

function previousPeriod(period) {
  const match = String(period || '').match(/^(20\d{2})\.([12])$/);
  if (!match) return '';
  const year = Number(match[1]);
  return Number(match[2]) === 2 ? `${year}.1` : `${year - 1}.2`;
}

function resolveModelPeriod(model, currentPeriod) {
  return String(model?.period || '').match(/^20\d{2}\.[12]$/)
    ? model.period
    : previousPeriod(currentPeriod);
}

function localDateISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatCaptureTime(value) {
  if (!value) return '';
  return String(value).replace(', ', ' · ');
}

function setStatus(kind, label, detail) {
  const card = document.getElementById('statusCard');
  card.className = `status-card ${kind}`;
  document.getElementById('statusLabel').textContent = label;
  document.getElementById('statusDetail').textContent = detail || '';
}

async function migrateModelPeriodIfNeeded(model, currentPeriod) {
  if (!model || model.period) return model;
  const inferred = resolveModelPeriod(model, currentPeriod);
  if (!inferred) return model;
  const migrated = { ...model, period: inferred };
  await storageSet({ [CADASTRO_KEY]: migrated });
  return migrated;
}

function renderApplicationResult(result, model, resp) {
  const card = document.getElementById('resultCard');
  const title = document.getElementById('resultTitle');
  const detail = document.getElementById('resultDetail');
  const button = document.getElementById('btnDetalhes');
  const list = document.getElementById('failureList');

  card.className = 'result-card';
  button.style.display = 'none';
  list.className = 'failure-list';
  list.replaceChildren();

  if (!result || !model || resp?.tipoCadastro !== 'editavel') return;
  if (result.modelCapturedAt && result.modelCapturedAt !== model.capturedAt) return;
  if (result.pageId && resp?.paginaId && result.pageId !== resp.paginaId) return;

  const total = Number(result.totalAnswers) || countModelAnswers(model);
  const matched = Math.min(Number(result.matched) || 0, total);
  const missing = Array.isArray(result.details) ? result.details : [];

  if (total > 0 && matched === total && missing.length === 0) {
    card.className = 'result-card success';
    title.textContent = `✓ ${matched}/${total} respostas aplicadas`;
    const textPart = result.textMatched ? ` · ${result.textMatched} campo de texto` : '';
    detail.textContent = `${result.questionCount || model.questions.length} questões verificadas${textPart}`;
    return;
  }

  card.className = 'result-card warning';
  title.textContent = `${matched}/${total} respostas aplicadas`;
  detail.textContent = `${Math.max(0, total - matched)} precisam de revisão.`;

  if (missing.length) {
    button.style.display = 'inline-block';
    missing.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'failure-item';

      const q = document.createElement('div');
      q.className = 'failure-question';
      q.textContent = `${Number.isInteger(item.questionIndex) ? item.questionIndex + 1 + '. ' : ''}${item.question || 'Questão'}`;

      const a = document.createElement('div');
      a.className = 'failure-answer';
      a.textContent = item.answer ? `Resposta: ${item.answer}` : '';

      const r = document.createElement('div');
      r.className = 'failure-reason';
      r.textContent = item.reason || 'Não foi possível confirmar esta resposta.';

      row.append(q, a, r);
      list.appendChild(row);
    });
  }
}

async function init() {
  const [resp, local] = await Promise.all([
    sendToTab({ acao: 'verificar' }),
    storageGet([CADASTRO_KEY, RESULT_KEY])
  ]);

  const btnPreencher = document.getElementById('btnPreencher');
  const btnSalvar = document.getElementById('btnSalvar');
  const cadastroSection = document.getElementById('cadastroSection');
  const btnCapturar = document.getElementById('btnCapturarCadastro');
  const btnAplicar = document.getElementById('btnAplicarCadastro');
  const cadastroDetail = document.getElementById('cadastroDetail');
  const modelRow = document.getElementById('modelRow');
  const modelPeriod = document.getElementById('modelPeriod');
  const modelMeta = document.getElementById('modelMeta');
  const applyHint = document.getElementById('applyHint');

  btnPreencher.style.display = 'none';
  btnSalvar.disabled = true;
  btnCapturar.style.display = 'none';
  btnAplicar.style.display = 'none';
  btnAplicar.disabled = true;
  cadastroSection.style.display = 'none';
  modelRow.style.display = 'none';
  cadastroDetail.textContent = '';
  applyHint.style.display = 'none';

  if (!resp || resp.ok === false) {
    setStatus('empty', 'Abra o SIGAA UFRN', resp?.msg || 'Navegue até uma página do SIGAA para usar.');
    if (local[CADASTRO_KEY]) {
      cadastroSection.style.display = 'block';
      const model = local[CADASTRO_KEY];
      modelRow.style.display = 'flex';
      modelPeriod.textContent = model.period || 'capturado';
      modelMeta.textContent = `${model.questions?.length || 0} questões · ${countModelAnswers(model)} respostas`;
      cadastroDetail.textContent = 'O modelo está salvo. Abra o Cadastro Único editável para aplicá-lo.';
      btnAplicar.style.display = 'block';
      applyHint.style.display = 'block';
      applyHint.textContent = 'O botão será liberado quando você estiver no formulário editável.';
    }
    carregarLista();
    return;
  }

  let model = local[CADASTRO_KEY] || null;
  model = await migrateModelPeriodIfNeeded(model, resp.currentPeriod);

  if (resp.temDados) {
    setStatus('ok', 'Dados desta página já estão salvos', `Salvo em ${resp.info.salvadoEm}`);
    btnPreencher.style.display = 'block';
  } else if (resp.tipoCadastro === 'visualizacao') {
    setStatus('info', 'Cadastro anterior detectado', 'Você pode usar esta tela como modelo para o período atual.');
  } else if (resp.tipoCadastro === 'editavel') {
    setStatus('info', 'Cadastro atual detectado', 'Revise as respostas antes de salvar ou enviar no SIGAA.');
  } else {
    setStatus('empty', 'Nenhum dado salvo para esta página', 'Salve apenas quando quiser poder restaurar este formulário depois.');
  }

  btnSalvar.disabled = !resp.podeSalvar;

  if (resp.tipoCadastro || model) {
    cadastroSection.style.display = 'block';
  }

  if (model) {
    modelRow.style.display = 'flex';
    const period = resolveModelPeriod(model, resp.currentPeriod) || '—';
    modelPeriod.textContent = period;
    modelMeta.textContent = `${model.questions?.length || 0} questões · ${countModelAnswers(model)} respostas`;
    cadastroDetail.textContent = model.capturedAt ? `Capturado em ${formatCaptureTime(model.capturedAt)}` : 'Modelo pronto para reutilizar.';

    btnAplicar.style.display = 'block';
    btnAplicar.disabled = resp.tipoCadastro !== 'editavel';
    if (resp.tipoCadastro !== 'editavel') {
      applyHint.style.display = 'block';
      applyHint.textContent = resp.tipoCadastro === 'visualizacao'
        ? 'Abra o Cadastro Único editável do período atual para aplicar.'
        : 'Abra o formulário editável do Cadastro Único para liberar este botão.';
    }
  } else if (resp.tipoCadastro === 'editavel') {
    cadastroDetail.textContent = 'Nenhum modelo salvo. Abra uma adesão anterior, capture as respostas e volte aqui.';
    btnAplicar.style.display = 'block';
    btnAplicar.disabled = true;
    applyHint.style.display = 'block';
    applyHint.textContent = 'Primeiro capture um cadastro anterior.';
  } else if (resp.tipoCadastro === 'visualizacao') {
    cadastroDetail.textContent = 'Capture as respostas desta adesão para reutilizar no cadastro novo.';
  }

  if (resp.tipoCadastro === 'visualizacao') {
    btnCapturar.style.display = 'block';
    btnCapturar.textContent = model ? 'Capturar novamente' : 'Capturar cadastro anterior';
  }

  renderApplicationResult(local[RESULT_KEY], model, resp);
  carregarLista();
}

function buildProfileItem(key, perfil) {
  const item = document.createElement('div');
  item.className = 'profile-item';

  const info = document.createElement('div');
  info.className = 'profile-info';
  const nome = document.createElement('div');
  nome.className = 'profile-name';
  const data = document.createElement('div');
  data.className = 'profile-date';
  const button = document.createElement('button');
  button.className = 'btn-mini';
  button.type = 'button';
  button.textContent = 'Remover';

  const rawTitle = String(perfil?.titulo || 'Página salva');
  const cleanTitle = rawTitle.replace(/SIGAA|Sistema Integrado|de Gestao|de Gestão/gi, '').trim().replace(/^[-–|]+/, '').trim() || key;
  nome.textContent = cleanTitle.length > 44 ? cleanTitle.slice(0, 44) + '…' : cleanTitle;
  nome.title = rawTitle;
  data.textContent = `${perfil?.salvadoEm || 'data desconhecida'} · ${countFields(perfil)} campos`;
  button.addEventListener('click', () => deletarPerfil(key));

  info.append(nome, data);
  item.append(info, button);
  return item;
}

function carregarLista() {
  chrome.storage.local.get([STORAGE_KEY], (result) => {
    const perfis = result[STORAGE_KEY] || {};
    const lista = document.getElementById('perfisList');
    const keys = Object.keys(perfis);
    lista.replaceChildren();

    if (!keys.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Nenhuma página salva ainda.';
      lista.appendChild(empty);
      return;
    }

    keys
      .sort((a, b) => String(perfis[b]?.salvadoEm || '').localeCompare(String(perfis[a]?.salvadoEm || '')))
      .forEach((key) => lista.appendChild(buildProfileItem(key, perfis[key])));
  });
}

function deletarPerfil(key) {
  chrome.storage.local.get([STORAGE_KEY], (result) => {
    const perfis = result[STORAGE_KEY] || {};
    delete perfis[key];
    chrome.storage.local.set({ [STORAGE_KEY]: perfis }, () => {
      carregarLista();
      init();
      toast('Dados removidos.', 'info');
    });
  });
}

async function exportar() {
  const [result, resp] = await Promise.all([
    storageGet([STORAGE_KEY, CADASTRO_KEY]),
    sendToTab({ acao: 'verificar' })
  ]);

  const perfis = result[STORAGE_KEY] || {};
  let cadastroModelo = result[CADASTRO_KEY] || null;
  if (Object.keys(perfis).length === 0 && !cadastroModelo) {
    toast('Não há dados para exportar.', 'error');
    return;
  }

  if (cadastroModelo && !cadastroModelo.period) {
    const period = resolveModelPeriod(cadastroModelo, resp?.currentPeriod);
    if (period) cadastroModelo = { ...cadastroModelo, period };
  }

  const pacote = {
    __sigaaAutoPreencheBackup: 2,
    perfis,
    cadastroModelo
  };

  const blob = new Blob([JSON.stringify(pacote, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;

  const period = cadastroModelo?.period || '';
  a.download = period
    ? `sigaa-autopreenche-cadastro-${period}-${localDateISO()}.json`
    : `sigaa-autopreenche-backup-${localDateISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  toast('Backup exportado. Guarde o arquivo em local privado.', 'success');
}

function isValidProfile(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.dados && typeof value.dados === 'object';
}

function isValidCadastroModelo(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.__schemaVersion === 1 && Array.isArray(value.questions);
}

function sanitizeProfiles(importado) {
  if (!importado || typeof importado !== 'object' || Array.isArray(importado)) return null;
  const safe = Object.create(null);
  for (const [key, value] of Object.entries(importado)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (typeof key !== 'string' || key.length > 2048 || !isValidProfile(value)) continue;
    safe[key] = value;
  }
  return safe;
}

function sanitizeImport(importado) {
  if (!importado || typeof importado !== 'object' || Array.isArray(importado)) return null;

  if (importado.__sigaaAutoPreencheBackup === 2) {
    const perfis = sanitizeProfiles(importado.perfis || {});
    const cadastroModelo = isValidCadastroModelo(importado.cadastroModelo) ? importado.cadastroModelo : null;
    if ((!perfis || Object.keys(perfis).length === 0) && !cadastroModelo) return null;
    return { perfis: perfis || {}, cadastroModelo };
  }

  const perfis = sanitizeProfiles(importado);
  if (!perfis || Object.keys(perfis).length === 0) return null;
  return { perfis, cadastroModelo: null };
}

function importar() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('Esse backup é grande demais.', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const importado = sanitizeImport(JSON.parse(ev.target.result));
        if (!importado) {
          toast('Arquivo de backup inválido.', 'error');
          return;
        }

        const result = await storageGet([STORAGE_KEY]);
        const merged = { ...(result[STORAGE_KEY] || {}), ...importado.perfis };
        const toSet = { [STORAGE_KEY]: merged };
        if (importado.cadastroModelo) toSet[CADASTRO_KEY] = importado.cadastroModelo;
        await storageSet(toSet);
        await storageRemove([RESULT_KEY]);

        const qtd = Object.keys(importado.perfis).length;
        const extra = importado.cadastroModelo ? ' e o modelo do Cadastro Único' : '';
        toast(`${qtd} página(s) importada(s)${extra}.`, 'success');
        carregarLista();
        init();
      } catch (_) {
        toast('Não consegui ler esse arquivo.', 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

document.getElementById('btnSalvar').addEventListener('click', async () => {
  const resp = await sendToTab({ acao: 'salvar' });
  if (resp.ok) {
    toast(`${resp.qtd} campos salvos.`, 'success');
    init();
  } else {
    toast(resp.msg || 'Erro ao salvar.', 'error');
  }
});

document.getElementById('btnPreencher').addEventListener('click', async () => {
  const resp = await sendToTab({ acao: 'preencher' });
  if (resp.ok) toast(`${resp.qtd} campos restaurados.`, 'success');
  else toast(resp.msg || 'Erro ao restaurar.', 'error');
});

document.getElementById('btnCapturarCadastro').addEventListener('click', async () => {
  const local = await storageGet([CADASTRO_KEY]);
  if (local[CADASTRO_KEY]) {
    const period = local[CADASTRO_KEY].period ? ` (${local[CADASTRO_KEY].period})` : '';
    const replace = window.confirm(`Já existe um cadastro capturado${period}. Substituir pelo cadastro desta tela?`);
    if (!replace) return;
  }

  const resp = await sendToTab({ acao: 'capturar_cadastro' });
  if (resp.ok) {
    await storageRemove([RESULT_KEY]);
    toast(`${resp.answerCount} respostas de ${resp.questionCount} questões capturadas.`, 'success');
    init();
  } else {
    toast(resp.msg || 'Não foi possível capturar o cadastro.', 'error');
  }
});

document.getElementById('btnAplicarCadastro').addEventListener('click', async () => {
  const button = document.getElementById('btnAplicarCadastro');
  button.disabled = true;
  button.textContent = 'Aplicando e conferindo...';

  const resp = await sendToTab({ acao: 'aplicar_cadastro' });
  const verify = await sendToTab({ acao: 'verificar' });
  const local = await storageGet([CADASTRO_KEY]);
  const model = local[CADASTRO_KEY] || null;

  button.textContent = 'Aplicar no cadastro atual';
  button.disabled = verify?.tipoCadastro !== 'editavel';

  if (resp.ok) {
    const result = {
      appliedAt: new Date().toLocaleString('pt-BR'),
      modelCapturedAt: model?.capturedAt || '',
      pageId: verify?.paginaId || '',
      matched: resp.matched || 0,
      totalAnswers: resp.totalAnswers || countModelAnswers(model),
      questionCount: resp.questionCount || model?.questions?.length || 0,
      textMatched: resp.textMatched || 0,
      details: Array.isArray(resp.details) ? resp.details : []
    };
    await storageSet({ [RESULT_KEY]: result });
    renderApplicationResult(result, model, verify);

    if (result.matched === result.totalAnswers && result.details.length === 0) {
      toast('Cadastro aplicado e conferido.', 'success');
    } else {
      toast('Algumas respostas precisam de revisão.', 'info');
    }
  } else {
    toast(resp.msg || 'Não foi possível aplicar o cadastro.', 'error');
  }
});

document.getElementById('btnDetalhes').addEventListener('click', () => {
  const list = document.getElementById('failureList');
  const button = document.getElementById('btnDetalhes');
  const open = list.classList.toggle('open');
  button.textContent = open ? 'Ocultar detalhes' : 'Ver detalhes';
});

document.getElementById('btnExportar').addEventListener('click', exportar);
document.getElementById('btnImportar').addEventListener('click', importar);

init();
