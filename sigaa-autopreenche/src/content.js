// SIGAA AutoPreenche - Content Script
// Salva somente dados de formulario. Senhas, arquivos, campos ocultos e botoes sao ignorados.

(function () {
  'use strict';

  const STORAGE_KEY = 'sigaa_autopreenche_perfis';
  const CADASTRO_KEY = 'sigaa_autopreenche_cadastro_modelo';
  const SCHEMA_VERSION = 2;
  const CADASTRO_SCHEMA_VERSION = 1;
  const VOLATILE_QUERY_RE = /(token|javax|jsf|viewstate|conversation|session|cid)/i;

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/([ #;?%&,.+*~\\':"!^$[\]()=>|/@])/g, '\\$1');
  }

  function getLabelText(el) {
    if (el.id) {
      const explicit = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (explicit) return normalizeText(explicit.textContent);
    }

    const wrapped = el.closest('label');
    if (wrapped) return normalizeText(wrapped.textContent);

    // SIGAA usa muitas tabelas. Prefira a celula imediatamente seguinte/anterior
    // antes de usar o texto da linha inteira, que pode conter varios campos.
    const td = el.closest('td, th');
    if (td) {
      const own = normalizeText(td.textContent);
      if (own && own.length <= 160) return own;

      const next = td.nextElementSibling;
      if (next) {
        const text = normalizeText(next.textContent);
        if (text && text.length <= 160) return text;
      }

      const prev = td.previousElementSibling;
      if (prev) {
        const text = normalizeText(prev.textContent);
        if (text && text.length <= 160) return text;
      }
    }

    const container = el.closest('li, span, div');
    if (container) {
      const text = normalizeText(container.textContent);
      if (text.length <= 160) return text;
    }

    return '';
  }

  function isEligible(el) {
    if (!el || el.disabled) return false;

    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return !!(el.name || el.id);
    if (tag !== 'input') return false;

    const type = (el.type || 'text').toLowerCase();
    const ignored = new Set([
      'password', 'file', 'hidden', 'submit', 'button', 'reset', 'image'
    ]);

    return !ignored.has(type) && !!(el.name || el.id);
  }

  function getEligibleFields() {
    return Array.from(document.querySelectorAll('input, select, textarea')).filter(isEligible);
  }

  function getOccurrenceIndex(el, fields) {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;
    const name = el.name || '';
    const same = fields.filter((candidate) => {
      const cTag = candidate.tagName.toLowerCase();
      const cType = cTag === 'input' ? (candidate.type || 'text').toLowerCase() : cTag;
      return cTag === tag && cType === type && (candidate.name || '') === name;
    });
    return Math.max(0, same.indexOf(el));
  }

  function serializeField(el, fields) {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;
    const base = {
      tag,
      type,
      name: el.name || '',
      id: el.id || '',
      index: getOccurrenceIndex(el, fields),
      label: getLabelText(el)
    };

    if (type === 'checkbox' || type === 'radio') {
      base.optionValue = el.value || '';
      base.checked = !!el.checked;
    } else if (tag === 'select' && el.multiple) {
      base.value = Array.from(el.selectedOptions).map((opt) => opt.value);
      base.multiple = true;
    } else {
      base.value = el.value;
    }

    return base;
  }

  function coletarCampos() {
    const fields = getEligibleFields();
    return {
      __schemaVersion: SCHEMA_VERSION,
      campos: fields.map((el) => serializeField(el, fields))
    };
  }

  function sameKind(el, saved) {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;
    return tag === saved.tag && type === saved.type;
  }

  function findField(saved, fields) {
    // 1) ID e o identificador mais estavel quando existe.
    if (saved.id) {
      const byId = document.getElementById(saved.id);
      if (byId && isEligible(byId) && sameKind(byId, saved)) return byId;
    }

    let candidates = fields.filter((el) => sameKind(el, saved));

    if (saved.name) {
      const byName = candidates.filter((el) => (el.name || '') === saved.name);
      if (byName.length) candidates = byName;
    }

    // 2) Para radio/checkbox, value normalmente identifica a opcao exata.
    if ((saved.type === 'checkbox' || saved.type === 'radio') && saved.optionValue !== undefined) {
      const byValue = candidates.find((el) => String(el.value || '') === String(saved.optionValue || ''));
      if (byValue) return byValue;
    }

    // 3) Posicao dentro do mesmo name/tipo.
    if (Number.isInteger(saved.index) && candidates[saved.index]) return candidates[saved.index];

    // 4) Label como ultimo fallback para componentes JSF cujo id pode mudar.
    if (saved.label) {
      const byLabel = candidates.find((el) => getLabelText(el) === saved.label);
      if (byLabel) return byLabel;
    }

    return candidates.length === 1 ? candidates[0] : null;
  }

  function dispatchValueEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function applyField(el, saved) {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;

    if (type === 'checkbox' || type === 'radio') {
      const desired = !!saved.checked;
      if (el.checked === desired) return false;

      // click() aciona handlers onclick antigos usados pelo SIGAA/JSF.
      try { el.click(); } catch (_) { /* fallback abaixo */ }
      if (el.checked !== desired) {
        el.checked = desired;
        dispatchValueEvents(el);
      }
      return true;
    }

    if (tag === 'select' && saved.multiple && Array.isArray(saved.value)) {
      let changed = false;
      Array.from(el.options).forEach((opt) => {
        const selected = saved.value.includes(opt.value);
        if (opt.selected !== selected) {
          opt.selected = selected;
          changed = true;
        }
      });
      if (changed) dispatchValueEvents(el);
      return changed;
    }

    const desired = saved.value == null ? '' : String(saved.value);
    if (el.value === desired) return false;
    el.value = desired;
    dispatchValueEvents(el);
    return true;
  }

  function preencherCamposV2(dados, touched) {
    if (!dados || !Array.isArray(dados.campos)) return 0;

    const fields = getEligibleFields();
    let changed = 0;

    dados.campos.forEach((saved, savedIndex) => {
      const el = findField(saved, fields);
      if (!el) return;
      if (applyField(el, saved)) {
        changed++;
        if (touched) touched.add(savedIndex);
      }
    });

    return changed;
  }

  // Compatibilidade com backups criados pela versao 1.0.
  function preencherCamposLegado(dados) {
    let preenchidos = 0;
    const form = document.querySelector('form');
    if (!form || !dados) return 0;

    form.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="hidden"]):not([type="reset"]):not([type="radio"]):not([type="checkbox"]):not([type="password"]):not([type="file"])').forEach((el) => {
      if (!el.name || dados[el.name] === undefined) return;
      if (el.value !== String(dados[el.name] ?? '')) {
        el.value = dados[el.name];
        dispatchValueEvents(el);
        preenchidos++;
      }
    });

    const radios = Array.from(form.querySelectorAll('input[type="radio"]'));
    radios.forEach((el) => {
      if (!el.name || dados[el.name] === undefined) return;
      const shouldCheck = String(el.value) === String(dados[el.name]);
      if (shouldCheck && !el.checked) {
        el.click();
        preenchidos++;
      }
    });

    const checks = Array.from(form.querySelectorAll('input[type="checkbox"]'));
    checks.forEach((el) => {
      if (!el.name) return;
      const values = Array.isArray(dados[el.name]) ? dados[el.name].map(String) : [];
      const labels = Array.isArray(dados['check_labels__' + el.name]) ? dados['check_labels__' + el.name] : [];
      const shouldCheck = values.includes(String(el.value)) || labels.includes(getLabelText(el));
      if (el.checked !== shouldCheck) {
        el.click();
        preenchidos++;
      }
    });

    form.querySelectorAll('select').forEach((el) => {
      if (!el.name || dados[el.name] === undefined) return;
      if (el.value !== String(dados[el.name])) {
        el.value = dados[el.name];
        el.dispatchEvent(new Event('change', { bubbles: true }));
        preenchidos++;
      }
    });

    form.querySelectorAll('textarea').forEach((el) => {
      if (!el.name || dados[el.name] === undefined) return;
      if (el.value !== String(dados[el.name] ?? '')) {
        el.value = dados[el.name];
        dispatchValueEvents(el);
        preenchidos++;
      }
    });

    return preenchidos;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function preencherCampos(dados) {
    if (!dados || dados.__schemaVersion !== SCHEMA_VERSION || !Array.isArray(dados.campos)) {
      return preencherCamposLegado(dados);
    }

    // Alguns selects do SIGAA atualizam outros campos via JSF/AJAX. Repetir em
    // pequenos intervalos permite preencher o elemento novo depois da atualizacao.
    const touched = new Set();
    preencherCamposV2(dados, touched);
    await delay(300);
    preencherCamposV2(dados, touched);
    await delay(700);
    preencherCamposV2(dados, touched);
    return touched.size;
  }


  // ===== Cadastro Unico: importar respostas de uma adesao anterior =====
  // A tela de visualizacao do SIGAA nao possui inputs. Ela representa as escolhas
  // com <span class="radio marcado"> e <span class="checkbox marcado">.

  function canonicalText(text) {
    return normalizeText(text)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[“”"'´`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanQuestionText(text) {
    return normalizeText(text).replace(/^\s*\d+\s*[.)-]\s*/, '').trim();
  }

  function cleanOptionText(text) {
    return normalizeText(text)
      .replace(/^\s*(?:[a-zA-Z]|\d+)\s*[.)-]\s*/, '')
      .trim();
  }

  function extractQuestionIndex(el) {
    if (!el) return null;
    const sources = [el.id, el.getAttribute && el.getAttribute('name')].filter(Boolean);
    const holder = el.closest && el.closest('[id*="dataTableQuestionario:"]');
    if (holder && holder.id) sources.push(holder.id);

    for (const source of sources) {
      const match = String(source).match(/dataTableQuestionario:(\d+):/);
      if (match) return Number(match[1]);
    }
    return null;
  }

  function getQuestionTable() {
    return document.getElementById('form:dataTableQuestionario') ||
      document.querySelector('table[id*="dataTableQuestionario"]');
  }

  function getCadastroPageType() {
    const table = getQuestionTable();
    if (!table) return null;

    const action = document.querySelector('form[action*="cadastro_unico"]')?.getAttribute('action') || '';
    const hasEditableInputs = !!table.querySelector('input[type="radio"], input[type="checkbox"], textarea, select, input[type="text"]');
    const hasRenderedAnswers = !!table.querySelector('.radio.marcado, .checkbox.marcado, .rich-panel-body');

    if (/visualizar_respostas\.jsf/i.test(action) || (!hasEditableInputs && hasRenderedAnswers)) return 'visualizacao';
    if (hasEditableInputs) return 'editavel';
    return null;
  }


  function getCurrentAcademicPeriod() {
    const strong = document.querySelector('.periodo-atual strong');
    const candidates = [strong?.textContent || '', document.querySelector('.periodo-atual')?.textContent || ''];
    for (const text of candidates) {
      const match = normalizeText(text).match(/(20\d{2})\s*[.]\s*([12])/);
      if (match) return `${match[1]}.${match[2]}`;
    }
    return '';
  }

  function previousAcademicPeriod(period) {
    const match = String(period || '').match(/^(20\d{2})[.]([12])$/);
    if (!match) return '';
    const year = Number(match[1]);
    const semester = Number(match[2]);
    return semester === 2 ? `${year}.1` : `${year - 1}.2`;
  }

  function academicPeriodFromDate(day, month, year) {
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || y < 2000 || y > 2100 || !Number.isInteger(m) || m < 1 || m > 12) return '';
    return `${y}.${m <= 6 ? 1 : 2}`;
  }

  function detectCadastroSourcePeriod() {
    // Na visualizacao antiga, o cabecalho continua mostrando o semestre ATUAL.
    // O historico do proprio cadastro, por outro lado, traz a data em que ele foi
    // submetido/alterado. Essa data e uma referencia melhor para rotular o modelo.
    const historyTables = Array.from(document.querySelectorAll('table')).filter((table) => {
      const header = canonicalText(table.querySelector('thead')?.textContent || '');
      return header.includes('situacao do cadastro unico') && header.includes('alterado por');
    });

    for (const table of historyTables) {
      const dates = Array.from(table.querySelectorAll('tbody tr'))
        .map((row) => normalizeText(row.textContent).match(/(\d{1,2})\/(\d{1,2})\/(20\d{2})/))
        .filter(Boolean)
        .map((match) => ({
          timestamp: new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])).getTime(),
          period: academicPeriodFromDate(match[1], match[2], match[3])
        }))
        .filter((item) => item.period)
        .sort((a, b) => b.timestamp - a.timestamp);
      if (dates.length) return dates[0].period;
    }

    const current = getCurrentAcademicPeriod();
    return previousAcademicPeriod(current);
  }

  function textWithoutHiddenMarker(span) {
    if (!span) return '';
    const clone = span.cloneNode(true);
    clone.querySelectorAll('.esconder').forEach((node) => node.remove());
    return normalizeText(clone.textContent);
  }

  function captureQuestion(questionEl, table) {
    const index = extractQuestionIndex(questionEl);
    if (!Number.isInteger(index)) return null;

    const questionText = cleanQuestionText(questionEl.textContent);
    const questionKey = canonicalText(questionText);
    if (!questionKey) return null;

    const selector = '[id*="dataTableQuestionario:' + index + ':"]';
    const cells = Array.from(table.querySelectorAll(selector));
    const allChoiceSpans = [];
    cells.forEach((cell) => {
      cell.querySelectorAll('.radio, .checkbox').forEach((span) => {
        if (!allChoiceSpans.includes(span)) allChoiceSpans.push(span);
      });
    });

    const choices = allChoiceSpans
      .map((span, optionIndex) => ({ span, optionIndex }))
      .filter(({ span }) => span.classList.contains('marcado'))
      .map(({ span, optionIndex }) => ({
        type: span.classList.contains('checkbox') ? 'checkbox' : 'radio',
        text: cleanOptionText(textWithoutHiddenMarker(span)),
        key: canonicalText(cleanOptionText(textWithoutHiddenMarker(span))),
        optionIndex
      }))
      .filter((choice) => choice.key);

    const questionCell = questionEl.closest('td');
    const panel = questionCell && questionCell.querySelector('.rich-panel-body');
    const textValue = panel ? normalizeText(panel.textContent) : '';

    if (!choices.length && !textValue) return null;

    return {
      index,
      question: questionText,
      questionKey,
      optionCount: allChoiceSpans.length,
      choices,
      textValue
    };
  }

  function captureCadastroAnterior() {
    const table = getQuestionTable();
    if (!table || getCadastroPageType() !== 'visualizacao') {
      return { ok: false, msg: 'Abra a tela de visualizacao do Cadastro Unico anterior.' };
    }

    const questions = Array.from(table.querySelectorAll('.pergunta'))
      .map((questionEl) => captureQuestion(questionEl, table))
      .filter(Boolean);

    if (!questions.length) {
      return { ok: false, msg: 'Nao encontrei respostas marcadas nesta visualizacao.' };
    }

    const optionAnswers = questions.reduce((sum, q) => sum + q.choices.length, 0);
    const textAnswers = questions.reduce((sum, q) => sum + (q.textValue ? 1 : 0), 0);

    return {
      ok: true,
      cadastro: {
        __schemaVersion: CADASTRO_SCHEMA_VERSION,
        sourceUrl: window.location.href,
        sourceTitle: document.title,
        capturedAt: new Date().toLocaleString('pt-BR'),
        period: detectCadastroSourcePeriod(),
        questions
      },
      questionCount: questions.length,
      answerCount: optionAnswers + textAnswers,
      optionAnswers,
      textAnswers
    };
  }

  function questionSimilarity(a, b) {
    const aa = new Set(canonicalText(a).split(' ').filter((word) => word.length > 2));
    const bb = new Set(canonicalText(b).split(' ').filter((word) => word.length > 2));
    if (!aa.size || !bb.size) return 0;
    let intersection = 0;
    aa.forEach((word) => { if (bb.has(word)) intersection++; });
    return intersection / Math.max(aa.size, bb.size);
  }

  function buildEditableQuestions() {
    const table = getQuestionTable();
    if (!table) return [];

    // Nem todas as telas editaveis do SIGAA mantem o <span class="pergunta">.
    // O identificador dataTableQuestionario:<indice>:, por outro lado, aparece
    // nos names/ids dos radios, checkboxes e campos de texto. Descobrir as
    // questoes pelos campos torna a replicacao independente do HTML visual.
    const questionTextByIndex = new Map();
    Array.from(table.querySelectorAll('.pergunta')).forEach((questionEl) => {
      const index = extractQuestionIndex(questionEl);
      if (!Number.isInteger(index)) return;
      const question = cleanQuestionText(questionEl.textContent);
      questionTextByIndex.set(index, question);
    });

    const groups = new Map();
    const editableFields = Array.from(table.querySelectorAll(
      'input[type="radio"], input[type="checkbox"], textarea, input[type="text"], select'
    )).filter((field) => !field.disabled);

    editableFields.forEach((field) => {
      const index = extractQuestionIndex(field);
      if (!Number.isInteger(index)) return;

      if (!groups.has(index)) {
        groups.set(index, {
          index,
          question: questionTextByIndex.get(index) || '',
          questionKey: canonicalText(questionTextByIndex.get(index) || ''),
          inputs: [],
          textFields: []
        });
      }

      const group = groups.get(index);
      const tag = field.tagName.toLowerCase();
      const type = tag === 'input' ? (field.type || 'text').toLowerCase() : tag;
      if (type === 'radio' || type === 'checkbox') group.inputs.push(field);
      else group.textFields.push(field);
    });

    // Se houver uma pergunta sem campo detectavel (raro), ainda a mantemos para
    // diagnostico. Para a aplicacao, os grupos descobertos pelos inputs bastam.
    questionTextByIndex.forEach((question, index) => {
      if (groups.has(index)) return;
      groups.set(index, {
        index,
        question,
        questionKey: canonicalText(question),
        inputs: [],
        textFields: []
      });
    });

    return Array.from(groups.values()).sort((a, b) => a.index - b.index);
  }

  function savedChoicesMatchCurrent(saved, current) {
    if (!saved || !current || !Array.isArray(saved.choices) || !saved.choices.length) return false;
    if (!Array.isArray(current.inputs) || !current.inputs.length) return false;

    const currentKeys = new Set(current.inputs.map(getInputOptionKey).filter(Boolean));
    return saved.choices.some((choice) => choice.key && currentKeys.has(choice.key));
  }

  function findEditableQuestion(saved, currentQuestions) {
    // Melhor caso: o texto da pergunta existe nas duas telas.
    const exact = currentQuestions.find((q) => q.questionKey && q.questionKey === saved.questionKey);
    if (exact) return exact;

    // A estrutura JSF do Cadastro Unico usa o mesmo indice da questao no modo
    // visualizar e no modo editar. Algumas versoes, porem, omitem .pergunta na
    // tela editavel; por isso o indice e um fallback essencial.
    const sameIndex = currentQuestions.find((q) => q.index === saved.index);
    if (!sameIndex) return null;

    if (!sameIndex.question) return sameIndex;
    if (questionSimilarity(saved.question, sameIndex.question) >= 0.65) return sameIndex;

    // Mesmo que a descricao tenha mudado levemente entre periodos, uma alternativa
    // identica (ex.: "De 18 a 25 anos") confirma que estamos no grupo correto.
    if (savedChoicesMatchCurrent(saved, sameIndex)) return sameIndex;

    return null;
  }

  function getInputOptionKey(input) {
    return canonicalText(cleanOptionText(getLabelText(input)));
  }

  function applyCapturedQuestion(saved, current, stats) {
    let touchedQuestion = false;

    if (saved.choices && saved.choices.length && current.inputs.length) {
      const byType = {
        radio: current.inputs.filter((input) => input.type === 'radio'),
        checkbox: current.inputs.filter((input) => input.type === 'checkbox')
      };

      for (const type of ['radio', 'checkbox']) {
        const savedChoices = saved.choices.filter((choice) => choice.type === type);
        if (!savedChoices.length) continue;

        const candidates = byType[type];
        if (!candidates.length) {
          stats.skipped += savedChoices.length;
          continue;
        }

        const matched = [];
        for (const choice of savedChoices) {
          let input = candidates.find((candidate) => getInputOptionKey(candidate) === choice.key);

          // Se os textos nao casarem, a posicao so e usada quando o numero de
          // alternativas continua exatamente igual ao cadastro anterior.
          if (!input && saved.optionCount === candidates.length && candidates[choice.optionIndex]) {
            input = candidates[choice.optionIndex];
          }

          if (input) matched.push(input);
          else stats.skipped++;
        }

        if (type === 'radio') {
          const target = matched[0];
          if (target) {
            if (!target.checked) {
              try { target.click(); } catch (_) { target.checked = true; dispatchValueEvents(target); }
              stats.changed++;
            }
            stats.matched++;
            touchedQuestion = true;
          }
        } else {
          const desired = new Set(matched);
          candidates.forEach((input) => {
            const shouldCheck = desired.has(input);
            if (input.checked !== shouldCheck) {
              try { input.click(); } catch (_) { input.checked = shouldCheck; dispatchValueEvents(input); }
              stats.changed++;
            }
          });
          stats.matched += matched.length;
          touchedQuestion = touchedQuestion || matched.length > 0;
        }
      }
    }

    if (saved.textValue) {
      if (current.textFields.length === 1) {
        const field = current.textFields[0];
        if (field.value !== saved.textValue) {
          field.value = saved.textValue;
          dispatchValueEvents(field);
          stats.changed++;
        }
        stats.matched++;
        touchedQuestion = true;
      } else {
        stats.skipped++;
      }
    }

    if (touchedQuestion) stats.questions.add(saved.index);
  }

  function applyCadastroPass(cadastro, aggregate) {
    const currentQuestions = buildEditableQuestions();
    const stats = {
      changed: 0,
      matched: 0,
      skipped: 0,
      questions: new Set()
    };

    cadastro.questions.forEach((saved) => {
      const current = findEditableQuestion(saved, currentQuestions);
      if (!current) {
        stats.skipped += (saved.choices?.length || 0) + (saved.textValue ? 1 : 0);
        return;
      }
      applyCapturedQuestion(saved, current, stats);
    });

    if (aggregate) {
      aggregate.changed += stats.changed;
      aggregate.matched = Math.max(aggregate.matched, stats.matched);
      aggregate.skipped = Math.min(aggregate.skipped, stats.skipped);
      stats.questions.forEach((index) => aggregate.questions.add(index));
    }
    return stats;
  }


  function findSavedChoiceInput(choice, savedQuestion, currentQuestion) {
    if (!choice || !currentQuestion) return null;
    const candidates = currentQuestion.inputs.filter((input) => input.type === choice.type);
    if (!candidates.length) return null;

    let input = candidates.find((candidate) => getInputOptionKey(candidate) === choice.key);
    if (!input && savedQuestion.optionCount === candidates.length && candidates[choice.optionIndex]) {
      input = candidates[choice.optionIndex];
    }
    return input || null;
  }

  function verifyCadastroApplied(cadastro) {
    const currentQuestions = buildEditableQuestions();
    const details = [];
    const matchedQuestions = new Set();
    let matched = 0;
    let totalAnswers = 0;
    let textMatched = 0;

    cadastro.questions.forEach((saved) => {
      const choices = Array.isArray(saved.choices) ? saved.choices : [];
      const hasText = !!saved.textValue;
      totalAnswers += choices.length + (hasText ? 1 : 0);

      const current = findEditableQuestion(saved, currentQuestions);
      if (!current) {
        choices.forEach((choice) => details.push({
          questionIndex: saved.index,
          question: saved.question,
          answer: choice.text,
          reason: 'Pergunta nao encontrada no formulario atual.'
        }));
        if (hasText) details.push({
          questionIndex: saved.index,
          question: saved.question,
          answer: 'Resposta de texto',
          reason: 'Campo de texto nao encontrado no formulario atual.'
        });
        return;
      }

      choices.forEach((choice) => {
        const input = findSavedChoiceInput(choice, saved, current);
        if (!input) {
          details.push({
            questionIndex: saved.index,
            question: saved.question,
            answer: choice.text,
            reason: 'Alternativa nao encontrada.'
          });
          return;
        }
        if (!input.checked) {
          details.push({
            questionIndex: saved.index,
            question: saved.question,
            answer: choice.text,
            reason: 'A alternativa foi localizada, mas nao ficou marcada.'
          });
          return;
        }
        matched++;
        matchedQuestions.add(saved.index);
      });

      if (hasText) {
        if (current.textFields.length !== 1) {
          details.push({
            questionIndex: saved.index,
            question: saved.question,
            answer: 'Resposta de texto',
            reason: 'Campo de texto nao encontrado de forma segura.'
          });
        } else if (normalizeText(current.textFields[0].value) !== normalizeText(saved.textValue)) {
          details.push({
            questionIndex: saved.index,
            question: saved.question,
            answer: 'Resposta de texto',
            reason: 'O texto nao ficou igual ao cadastro capturado.'
          });
        } else {
          matched++;
          textMatched++;
          matchedQuestions.add(saved.index);
        }
      }
    });

    return {
      matched,
      totalAnswers,
      skipped: Math.max(0, totalAnswers - matched),
      questions: matchedQuestions.size,
      questionCount: cadastro.questions.length,
      textMatched,
      details: details.slice(0, 60),
      detectedQuestions: currentQuestions.length,
      detectedOptions: currentQuestions.reduce((sum, q) => sum + q.inputs.length, 0)
    };
  }

  async function applyCadastroAnterior(cadastro) {
    if (!cadastro || cadastro.__schemaVersion !== CADASTRO_SCHEMA_VERSION || !Array.isArray(cadastro.questions)) {
      return { ok: false, msg: 'O cadastro capturado esta invalido ou e de uma versao antiga.' };
    }
    if (getCadastroPageType() !== 'editavel') {
      return { ok: false, msg: 'Abra o formulario editavel do Cadastro Unico atual.' };
    }

    const aggregate = {
      changed: 0,
      matched: 0,
      skipped: Number.MAX_SAFE_INTEGER,
      questions: new Set()
    };

    // Repassa apos pequenos intervalos porque o SIGAA pode reconstruir trechos
    // do formulario quando handlers JSF sao acionados.
    applyCadastroPass(cadastro, aggregate);
    await delay(250);
    applyCadastroPass(cadastro, aggregate);
    await delay(650);
    applyCadastroPass(cadastro, aggregate);

    if (aggregate.skipped === Number.MAX_SAFE_INTEGER) aggregate.skipped = 0;
    const verification = verifyCadastroApplied(cadastro);
    return {
      ok: true,
      changed: aggregate.changed,
      matched: verification.matched,
      totalAnswers: verification.totalAnswers,
      skipped: verification.skipped,
      questions: verification.questions,
      questionCount: verification.questionCount,
      textMatched: verification.textMatched,
      details: verification.details,
      detectedQuestions: verification.detectedQuestions,
      detectedOptions: verification.detectedOptions
    };
  }

  function getPaginaId() {
    const url = new URL(window.location.href);
    const pathname = url.pathname.replace(/;jsessionid=[^/?#]*/i, '');
    const stableParams = [];

    url.searchParams.forEach((value, key) => {
      if (!VOLATILE_QUERY_RE.test(key)) stableParams.push([key, value]);
    });

    stableParams.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    const query = stableParams.map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
    return url.hostname + pathname + (query ? '?' + query : '');
  }

  function countSavedFields(dados) {
    if (dados && dados.__schemaVersion === SCHEMA_VERSION && Array.isArray(dados.campos)) {
      return dados.campos.length;
    }
    return dados ? Object.keys(dados).filter((key) => !key.startsWith('radio_label__') && !key.startsWith('check_labels__')).length : 0;
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.acao) return false;

    if (msg.acao === 'salvar') {
      const dados = coletarCampos();
      const paginaId = getPaginaId();

      chrome.storage.local.get([STORAGE_KEY], function (result) {
        const perfis = result[STORAGE_KEY] || {};
        perfis[paginaId] = {
          url: window.location.href,
          titulo: document.title,
          dados,
          fieldCount: countSavedFields(dados),
          salvadoEm: new Date().toLocaleString('pt-BR')
        };

        chrome.storage.local.set({ [STORAGE_KEY]: perfis }, function () {
          sendResponse({ ok: true, qtd: countSavedFields(dados) });
        });
      });
      return true;
    }

    if (msg.acao === 'preencher') {
      const paginaId = getPaginaId();
      chrome.storage.local.get([STORAGE_KEY], async function (result) {
        const perfis = result[STORAGE_KEY] || {};
        if (!perfis[paginaId]) {
          sendResponse({ ok: false, msg: 'Nenhum dado salvo para esta pagina.' });
          return;
        }

        const qtd = await preencherCampos(perfis[paginaId].dados);
        sendResponse({ ok: true, qtd });
      });
      return true;
    }

    if (msg.acao === 'capturar_cadastro') {
      const captured = captureCadastroAnterior();
      if (!captured.ok) {
        sendResponse(captured);
        return false;
      }

      chrome.storage.local.set({ [CADASTRO_KEY]: captured.cadastro }, function () {
        sendResponse({
          ok: true,
          questionCount: captured.questionCount,
          answerCount: captured.answerCount,
          optionAnswers: captured.optionAnswers,
          textAnswers: captured.textAnswers,
          period: captured.cadastro.period || ''
        });
      });
      return true;
    }

    if (msg.acao === 'aplicar_cadastro') {
      chrome.storage.local.get([CADASTRO_KEY], async function (result) {
        const cadastro = result[CADASTRO_KEY];
        if (!cadastro) {
          sendResponse({ ok: false, msg: 'Capture primeiro o Cadastro Unico anterior.' });
          return;
        }
        const applied = await applyCadastroAnterior(cadastro);
        sendResponse(applied);
      });
      return true;
    }

    if (msg.acao === 'verificar') {
      const paginaId = getPaginaId();
      chrome.storage.local.get([STORAGE_KEY, CADASTRO_KEY], function (result) {
        const perfis = result[STORAGE_KEY] || {};
        const cadastro = result[CADASTRO_KEY] || null;
        sendResponse({
          ok: true,
          temDados: !!perfis[paginaId],
          info: perfis[paginaId] || null,
          paginaId,
          tipoCadastro: getCadastroPageType(),
          currentPeriod: getCurrentAcademicPeriod(),
          podeSalvar: getEligibleFields().length > 0,
          temCadastroCapturado: !!cadastro,
          cadastroInfo: cadastro ? {
            capturedAt: cadastro.capturedAt,
            period: cadastro.period || '',
            questionCount: Array.isArray(cadastro.questions) ? cadastro.questions.length : 0,
            answerCount: Array.isArray(cadastro.questions)
              ? cadastro.questions.reduce((sum, q) => sum + (Array.isArray(q.choices) ? q.choices.length : 0) + (q.textValue ? 1 : 0), 0)
              : 0
          } : null
        });
      });
      return true;
    }

    return false;
  });
})();
