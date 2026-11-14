// The intake form: the inventor's own words, kept by the app.
import { S, $, state, esc, toast, guard } from './core.js';
import { openProject } from './app.js';

export function intakeModal(existing) {
  const i = existing?.intake || {};
  const root = $('#modal-root');
  const inv = i.inventors?.length ? i.inventors : [{ name: '', residence: '' }];
  let materials = [...(i.materials || [])];
  root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-label="Your invention">
    <h2>${existing ? 'Your answers' : 'Describe your idea'}</h2>
    <p class="muted">Your chosen AI sends your answers and material it reads to Anthropic or OpenAI.</p>
    <div class="stack" style="margin-top:14px">
      <label class="field">Invention name<input type="text" id="f-title" value="${esc(i.title || '')}" placeholder="Self-leveling camping table"></label>
      <label class="field">What is it?<textarea id="f-desc">${esc(i.description || '')}</textarea></label>
      <div class="grid2">
        <label class="field">What problem does it solve?<textarea id="f-problem">${esc(i.problem || '')}</textarea></label>
        <label class="field">How does it work, and what is different about it?<textarea id="f-how">${esc(i.how || '')}</textarea></label>
      </div>
      <div class="field">Notes, sketches, documents or code to read<span class="hint">Optional. The AI reads these and never changes them.</span>
        <div id="mat-list" class="outputs" style="margin-top:4px"></div>
        <div><button class="btn sm" id="add-mat">Add files or a folder</button></div>
      </div>
      <div class="field">Inventors<span class="hint">Full name and city, state or country for each person. Used on the cover sheet.</span>
        <div id="inv-list" class="stack" style="gap:6px"></div>
        <div><button class="btn sm" id="add-inv">Add another inventor</button></div>
      </div>
      <label class="field">Have you shown it in public, published it, demonstrated it, or offered it for sale?<span class="hint">Public disclosure can limit filing time in the US and prevent patents abroad. See Costs and legal help.</span>
        <select id="f-disc">
          ${['Not sure', 'No, never', 'Yes'].map((o) => `<option ${i.disclosed === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select></label>
      <label class="field">What did you share, and when?<textarea id="f-discn" placeholder="Posted a video on March 2, 2026; shared code publicly last spring">${esc(i.disclosureNotes || '')}</textarea></label>
      <label class="field">Public links the AI should check<span class="hint">Optional. Website, store page, public code or videos.</span><input type="text" id="f-links" value="${esc(i.publicLinks || '')}"></label>
      <div class="grid2">
        <label class="field">Filing goal<select id="f-target">${['US provisional application', 'US provisional, then European (EPO)', 'Not sure yet'].map((o) => `<option ${i.target === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
        <label class="field">Filing fee category<span class="hint">Choose only if you have checked eligibility. See Costs and legal help.</span><select id="f-entity">${['Not sure', 'Micro entity', 'Small entity', 'Standard (large) entity'].map((o) => `<option ${i.entity === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
      </div>
      <label class="field">Mailing address for the Patent Office<span class="hint">Optional now; needed for the cover sheet.</span><input type="text" id="f-corr" value="${esc(i.correspondence || '')}"></label>
      <label class="field">How you developed the idea<span class="hint">Record when and how you came up with the solution.</span><textarea id="f-conc">${esc(i.conception || '')}</textarea></label>
    </div>
    <div class="actions"><button class="btn ghost" id="m-cancel">Cancel</button><button class="btn primary" id="m-save">${existing ? 'Save' : 'Create invention'}</button></div>
  </div></div>`;
  const invList = $('#inv-list');
  const drawInv = () => {
    invList.innerHTML = inv
      .map((x, k) => `<div class="grid2"><input type="text" data-k="${k}" data-f="name" placeholder="Full name" value="${esc(x.name)}"><input type="text" data-k="${k}" data-f="residence" placeholder="City, state or country" value="${esc(x.residence || '')}"></div>`)
      .join('');
    invList.querySelectorAll('input').forEach((el) => (el.oninput = () => (inv[el.dataset.k][el.dataset.f] = el.value)));
  };
  const drawMat = () => {
    $('#mat-list').innerHTML = materials.map((m, k) => `<button class="file-chip" data-k="${k}" title="Remove">${esc(m)} ✕</button>`).join('') || '<span class="muted small">None</span>';
    $('#mat-list').querySelectorAll('button').forEach((b) => (b.onclick = () => (materials.splice(+b.dataset.k, 1), drawMat())));
  };
  drawInv();
  drawMat();
  $('#add-inv').onclick = () => (inv.push({ name: '', residence: '' }), drawInv());
  $('#add-mat').onclick = async () => {
    const picked = await guard(() => S.pickMaterial());
    if (picked?.length) ((materials = [...new Set([...materials, ...picked])]), drawMat());
  };
  $('#m-cancel').onclick = () => (root.innerHTML = '');
  $('#m-save').onclick = async () => {
    const intake = {
      title: $('#f-title').value.trim() || 'Untitled invention',
      description: $('#f-desc').value.trim(),
      problem: $('#f-problem').value.trim(),
      how: $('#f-how').value.trim(),
      materials,
      inventors: inv.filter((x) => x.name.trim()),
      disclosed: $('#f-disc').value,
      disclosureNotes: $('#f-discn').value.trim(),
      publicLinks: $('#f-links').value.trim(),
      target: $('#f-target').value,
      entity: $('#f-entity').value,
      correspondence: $('#f-corr').value.trim(),
      conception: $('#f-conc').value.trim(),
    };
    if (!intake.description && !materials.length) return toast('The invention needs a description or source material. Add a description or files.', true);
    const p = await guard(() => (existing ? S.updateIntake(existing.id, intake) : S.createProject(intake)));
    if (!p) return;
    root.innerHTML = '';
    openProject(p.id);
  };
}
