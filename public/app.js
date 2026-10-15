// Sponsor Scout front end: podcast search, live agent steps over SSE, shortlist rendering.
const $ = (id) => document.getElementById(id);
const state = { podcast: null, results: [], active: -1, timer: 0, running: false };

const input = $('podcast');
const list = $('podcast-list');

function setPicked(p) {
  state.podcast = p;
  $('go').disabled = !p || state.running;
  const hint = $('picked');
  hint.textContent = p ? `Selected: ${p.name}` : 'Pick your show from the list so the agent works on the right one.';
  hint.classList.toggle('ok', !!p);
}

function closeList() {
  list.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  state.active = -1;
}

function renderList() {
  list.replaceChildren(
    ...state.results.map((p, i) => {
      const li = document.createElement('li');
      li.role = 'option';
      li.setAttribute('aria-selected', String(i === state.active));
      li.textContent = p.name;
      const tags = document.createElement('span');
      tags.className = 'tags';
      tags.textContent = p.tags.filter((t) => t !== 'Podcasts').slice(0, 4).join(' · ');
      li.append(tags);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(i);
      });
      return li;
    }),
  );
  list.hidden = state.results.length === 0;
  input.setAttribute('aria-expanded', String(!list.hidden));
}

function choose(i) {
  const p = state.results[i];
  if (!p) return;
  input.value = p.name;
  setPicked(p);
  closeList();
}

async function search(q) {
  const res = await fetch(`/api/podcasts?q=${encodeURIComponent(q)}`);
  const data = await res.json().catch(() => ({}));
  if (input.value.trim() !== q) return [];
  state.results = Array.isArray(data.results) ? data.results : [];
  state.active = state.results.length ? 0 : -1;
  renderList();
  return state.results;
}

input.addEventListener('input', () => {
  setPicked(null);
  clearTimeout(state.timer);
  const q = input.value.trim();
  if (q.length < 2) return closeList();
  state.timer = setTimeout(() => search(q), 300);
});
input.addEventListener('keydown', (e) => {
  if (list.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = state.results.length;
    state.active = (state.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderList();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(state.active);
  } else if (e.key === 'Escape') closeList();
});
input.addEventListener('blur', () => setTimeout(closeList, 100));

document.querySelectorAll('[data-example]').forEach((b) =>
  b.addEventListener('click', async () => {
    input.value = b.dataset.example;
    setPicked(null);
    const found = await search(input.value);
    if (found.length) choose(0);
  }),
);

function addStep(s) {
  const li = document.createElement('li');
  li.textContent = s.label;
  const d = document.createElement('span');
  d.className = 'detail';
  d.textContent = s.detail;
  li.append(d);
  $('steps').append(li);
}

function chip(text) {
  const c = document.createElement('span');
  c.className = 'chip';
  c.textContent = text;
  return c;
}

function outreachNote(pick, result) {
  return [
    `Subject: ${result.podcast.name} x ${pick.brand}`,
    '',
    `Hi ${pick.brand} team,`,
    '',
    `I host ${result.podcast.name}. ${pick.why}`,
    pick.pitchAngle ? `What I have in mind: ${pick.pitchAngle}` : '',
    '',
    'Would you be open to a short chat by email about a sponsorship this quarter? I can send audience numbers and rates.',
    '',
    'Thanks,',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
}

function renderResult(r) {
  $('audience-summary').textContent = r.audience.summary;
  $('audience-skews').replaceChildren(...r.audience.skews.map(chip));
  const notes = $('notes');
  notes.replaceChildren(
    ...r.notes.map((n) => {
      const p = document.createElement('p');
      p.className = 'card note';
      p.textContent = n;
      return p;
    }),
  );
  const groups = new Map();
  for (const p of r.picks) {
    if (!groups.has(p.category)) groups.set(p.category, []);
    groups.get(p.category).push(p);
  }
  const tpl = $('pick-tpl');
  $('groups').replaceChildren(
    ...[...groups].map(([cat, picks]) => {
      const sec = document.createElement('section');
      sec.className = 'group';
      const h = document.createElement('h2');
      h.textContent = cat;
      const grid = document.createElement('div');
      grid.className = 'picks';
      for (const p of picks) {
        const card = tpl.content.firstElementChild.cloneNode(true);
        const a = card.querySelector('.name');
        a.textContent = p.brand;
        if (/^https?:\/\//.test(p.evidence.site)) a.href = p.evidence.site;
        card.querySelector('.bar span').style.width = `${Math.round(p.evidence.affinity * 100)}%`;
        card.querySelector('.value').textContent = `affinity ${p.evidence.affinity.toFixed(2)} · #${p.evidence.rank} of ${p.evidence.of}${p.evidence.list === 'look-alike' ? ' look-alikes' : ''}`;
        card.querySelector('.why').textContent = p.why;
        const angle = card.querySelector('.angle');
        if (p.pitchAngle) angle.querySelector('span').textContent = p.pitchAngle;
        else angle.remove();
        const facts = card.querySelector('.facts');
        const e = p.evidence;
        [e.brandType[0], e.businessModel.slice(0, 2).join(' / '), e.keyMarkets.slice(0, 2).join(', '), e.targetAge.slice(0, 2).join(', '), e.signals.length > 1 ? e.signals.slice(1).join(', ') : '']
          .filter(Boolean)
          .forEach((t) => facts.append(chip(t)));
        const copy = card.querySelector('.copy');
        copy.addEventListener('click', async () => {
          await navigator.clipboard.writeText(outreachNote(p, r));
          copy.textContent = 'Copied';
          setTimeout(() => (copy.textContent = 'Copy outreach note'), 1500);
        });
        grid.append(card);
      }
      sec.append(h, grid);
      return sec;
    }),
  );
  const sk = $('skipped');
  sk.hidden = !r.skipped.length;
  $('skipped-list').replaceChildren(
    ...r.skipped.map((s) => {
      const li = document.createElement('li');
      li.textContent = `${s.brand}: ${s.reason}`;
      return li;
    }),
  );
  $('result').hidden = false;
}

async function run(body) {
  state.running = true;
  $('go').disabled = true;
  $('run').hidden = false;
  $('result').hidden = true;
  $('steps').replaceChildren();
  const status = $('status');
  status.className = 'status';
  status.textContent = 'The agent is working. This takes 10 to 30 seconds.';
  try {
    const res = await fetch('/api/scout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += chunk.value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] ?? 'null');
        if (event === 'step') addStep(data);
        else if (event === 'status') status.textContent = data.message;
        else if (event === 'result') {
          status.textContent = data.mode === 'agent' ? `Done. Model: ${data.model}.` : 'Done, without the language model.';
          renderResult(data);
          done = true;
        } else if (event === 'error') throw new Error(data.message);
      }
    }
  } catch (e) {
    status.className = 'status error';
    status.textContent = e.message || 'Something went wrong.';
  } finally {
    state.running = false;
    $('go').disabled = !state.podcast;
  }
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.podcast || state.running) return;
  run({
    podcastId: state.podcast.id,
    podcastName: state.podcast.name,
    pastSponsors: $('sponsors').value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3),
    focus: $('focus').value.trim(),
  });
});
