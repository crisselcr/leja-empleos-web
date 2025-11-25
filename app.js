// ===== Firebase (importa tu SDK de utilidades) =====
import {
    auth, onAuth, signInEmail, signUpEmail, signOutUser,
    createJob, updateJob, getMyJobs, listJobsPublic,
    createApply, getAppliesByOwner, getAppliesByCandidate, updateApply,
    getFavorites, toggleFavorite as toggleFavoriteFB
} from './firebase.js';

// Guarda la última lista de vacantes traídas de Firestore (para búsquedas/favoritos)
let JOBS_CACHE = [];
// Vacante que el usuario está viendo en el modal
let currentJob = null;

// ===== Polyfill UUID (por si el navegador es viejo) =====
if (!window.crypto) window.crypto = {};
if (typeof window.crypto.randomUUID !== 'function') {
    window.crypto.randomUUID = () =>
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
}

// ===== Helpers / Estado local =====
const qs = (s, sc = document) => sc.querySelector(s);
const SESSION_ROLE = 'lejaRol';        // rol temporal (hasta migrar a perfil en Firestore)
const SESSION_COMPANY = 'lejaEmpresa'; // empresa temporal

const fmtDate = ts => new Date(ts).toLocaleDateString('es-MX', {
    year: 'numeric', month: 'short', day: 'numeric'
});

// Sesión derivada de Auth + datos temporales de rol/empresa
const getSession = () => {
    const u = auth.currentUser;
    if (!u) return null;
    const rol = localStorage.getItem(SESSION_ROLE) || 'candidato';
    const empresa = localStorage.getItem(SESSION_COMPANY) || '';
    return { rol, correo: u.email, empresa };
};

// Vistas
const VIEWS = {
    home: qs('#view-home'),
    vacantes: qs('#view-vacantes'),
    publicar: qs('#view-publicar'),
    panel: qs('#view-panel'),
    perfil: qs('#view-perfil'),
};

// Plantillas rápidas (modal responder)
const RESP_TEMPLATES = [
    'Perfil interesante para futuras vacantes.',
    'Experiencia insuficiente para los requisitos actuales.',
    'Falta dominio de herramientas solicitadas.',
    'Horarios/ubicación no compatibles.',
    'Vacante ocupada. ¡Gracias por tu interés!'
];

// ===== Catálogo MX (Estados y Municipios) =====
let MX = { estados: [] }; // { id, nombre, municipios[] }

async function loadMXCatalog() {
    try {
        const res = await fetch('./mx-municipios.json');
        MX.estados = await res.json() || [];
    } catch (e) {
        console.error('No se pudo cargar mx-municipios.json', e);
        MX.estados = [];
    }
}
function fillEstados(selectEl, withAllOption = true) {
    if (!selectEl) return;
    const cur = selectEl.value;
    selectEl.innerHTML = withAllOption ? '<option value="">Todos</option>' : '<option value="">Selecciona estado</option>';
    MX.estados.forEach(e => {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.nombre;
        selectEl.appendChild(opt);
    });
    if (cur) selectEl.value = cur;
}
function fillMunicipios(selectEl, estadoId, withAllOption = true) {
    if (!selectEl) return;
    selectEl.innerHTML = withAllOption ? '<option value="">Todos</option>' : '<option value="">Selecciona municipio</option>';
    const e = MX.estados.find(x => x.id === estadoId);
    if (!e) { selectEl.disabled = true; return; }
    (e.municipios || []).forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        selectEl.appendChild(opt);
    });
    selectEl.disabled = false;
}
function nombreEstadoById(id) {
    return MX.estados.find(e => e.id === id)?.nombre || '';
}

// ===== Navegación =====
function show(name) {
    if (name === 'publicar') gatePublish();
    if (name === 'panel') renderPanel();
    if (name === 'perfil') renderPerfil();
    Object.values(VIEWS).forEach(v => v?.classList.remove('active'));
    VIEWS[name]?.classList.add('active');
    document.querySelectorAll('[data-view]').forEach(a => a.classList.toggle('active', a.dataset.view === name));
}
document.addEventListener('click', e => {
    const t = e.target.closest('[data-view]'); if (!t) return; e.preventDefault(); show(t.dataset.view);
});

// ===== UI de Auth (botones navbar) =====
function updateAuthUI() {
    const ses = getSession(); const logged = !!ses;
    document.querySelectorAll('.auth-buttons').forEach(el => el.classList.toggle('d-none', logged));
    document.querySelectorAll('.nav-perfil').forEach(el => el.classList.toggle('d-none', !logged));
    document.querySelectorAll('.nav-panel').forEach(el => el.classList.toggle('d-none', !(logged && ses.rol === 'reclutador')));
}

// ===== JOBS (Firebase) =====
async function loadJobs() {
    JOBS_CACHE = await listJobsPublic(); // [{id, ...}]
    applyFilters({});
}

// ===== Buscadores / filtros (Vacantes) =====
qs('#frmSearchHome')?.addEventListener('submit', e => {
    e.preventDefault();
    const q = qs('#txtPuestoHome').value.trim().toLowerCase();
    const loc = qs('#txtUbicacionHome').value.trim().toLowerCase(); // libre
    show('vacantes'); applyFilters({ q, loc });
});
qs('#frmSearchVacantesTop')?.addEventListener('submit', e => {
    e.preventDefault();
    applyFilters({ q: qs('#txtPuesto').value.trim().toLowerCase(), loc: qs('#txtUbicacion').value.trim().toLowerCase() });
});
qs('#btnAplicarFiltros')?.addEventListener('click', e => {
    e.preventDefault();
    const tipos = ['fTiempo', 'fMedio', 'fRemoto'].filter(id => qs('#' + id).checked).map(id => qs('#' + id).value);
    applyFilters({
        q: qs('#txtPuesto')?.value.trim().toLowerCase() || '',
        loc: '',
        ciudad: '',
        min: parseInt(qs('#fRango').value || '0', 10),
        tipos,
        estadoId: qs('#fEstado')?.value || '',
        municipio: qs('#fMunicipio')?.value || ''
    });
});

function applyFilters({ q = '', loc = '', min = 0, ciudad = '', tipos = [], estadoId = '', municipio = '' }) {
    const list = (JOBS_CACHE || [])
        .filter(j => j.status !== 'borrada')
        .filter(j => {
            const okQ = !q || (j.titulo + ' ' + (j.descripcion || '')).toLowerCase().includes(q);
            const okEstado = !estadoId || j.estadoId === estadoId;
            const okMun = !municipio || (j.municipio || '').toLowerCase() === municipio.toLowerCase();
            const okLoc = !loc || (j.ubicacion || '').toLowerCase().includes(loc);
            const okCiu = !ciudad || (j.ubicacion || '').toLowerCase().includes(ciudad);
            const okSal = !min || (j.salario || 0) >= min;
            const okTipo = !tipos.length || tipos.includes(j.tipo);
            return okQ && okSal && okTipo && okEstado && okMun && okLoc && okCiu;
        });
    renderJobs(list);
}

function renderJobs(list) {
    const c = qs('#listVacantes'); if (!c) return; c.innerHTML = '';
    if (!list.length) { c.innerHTML = '<div class="text-secondary">No hay resultados.</div>'; return; }
    list.forEach(j => {
        const ubic = j.ubicacion || [j.municipio, j.estado].filter(Boolean).join(', ') || '—';
        const card = document.createElement('div');
        card.className = 'card-job';
        card.innerHTML = `
      <div class="d-flex justify-content-between align-items-start gap-2">
        <div>
          <div class="h5 mb-1">${j.titulo}</div>
          <div class="text-secondary">${j.empresa}</div>
          <div class="small text-secondary">📍 ${ubic} · 🗓️ ${fmtDate(j.createdAt)}</div>
        </div>
        <div class="text-end">
          <div class="fw-semibold">${j.tipo}</div>
          <div>$${(j.salario || 0).toLocaleString('es-MX')} <span class="small text-secondary">/ ${j.periodo || 'Mensual'}</span></div>
          ${j.status === 'ocupada' ? '<span class="badge bg-secondary mt-1">Ocupada</span>' : ''}
        </div>
      </div>
      <div class="mt-2 d-flex gap-2">
        <button class="btn btn-outline-light btn-sm" data-action="detalle" data-id="${j.id}" data-bs-toggle="modal" data-bs-target="#detalleModal">Detalles</button>
        <button class="btn btn-outline-light btn-sm" data-action="fav" data-id="${j.id}">★ Favorito</button>
      </div>`;
        c.appendChild(card);
    });
}

// ===== Detalle / Postular / Favoritos / Panel =====
document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;

    const action = b.dataset.action;
    const id = b.dataset.id;

    // === Detalle de vacante (modal)
    if (action === 'detalle') {
        currentJob = JOBS_CACHE.find(j => j.id === id); if (!currentJob) return;
        const ubic = currentJob.ubicacion || [currentJob.municipio, currentJob.estado].filter(Boolean).join(', ');
        qs('#detalleTitulo').textContent = currentJob.titulo;
        qs('#detalleContenido').innerHTML = `
      <div class="mb-2">${currentJob.empresa} • ${ubic}</div>
      <div class="mb-3">${currentJob.tipo} • $${(currentJob.salario || 0).toLocaleString('es-MX')} / ${currentJob.periodo || 'Mensual'}</div>
      <pre class="mb-0" style="white-space:pre-wrap">${currentJob.descripcion || ''}</pre>`;
        return;
    }

    // === Favorito
    if (action === 'fav') {
        await toggleFavorite(id);
        return;
    }

    // === Panel: editar vacante
    if (action === 'edit-job') {
        loadToForm(id);
        show('publicar');
        return;
    }

    // === Panel: ver apps sólo de esa vacante
    if (action === 'ver-apps-job') {
        qs('#appJobFilter').value = id;
        document.querySelector('[data-bs-target="#tabPostulaciones"]')?.click();
        renderPanelApps();
        return;
    }

    // === Borrar (cambia status a 'borrada')
    if (action === 'del-job') {
        if (!confirm('¿Borrar esta vacante?')) return;
        try {
            await updateJob(id, { status: 'borrada' });
            await renderPanel();
        } catch (err) {
            console.error(err);
            alert('No se pudo borrar la vacante.');
        }
        return;
    }

    // (Ya no existe acción "mark-ocupada")
});

// Postularme: login o abre modal
qs('#btnPostularModal')?.addEventListener('click', () => {
    if (!currentJob) return;
    const ses = getSession();
    if (!ses) {
        localStorage.setItem('lejaPending', JSON.stringify({ type: 'apply', jobId: currentJob.id }));
        bootstrap.Modal.getInstance(qs('#detalleModal'))?.hide();
        new bootstrap.Modal(qs('#loginModal')).show();
        return;
    }
    qs('#frmPostular')?.reset();
    new bootstrap.Modal(qs('#postularModal')).show();
});

// Enviar postulación → Firestore
qs('#frmPostular')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentJob) return;
    const ses = getSession(); if (!ses) return;

    const nombre = qs('#pNombre').value.trim();
    const correo = (qs('#pCorreo').value || ses.correo || '').trim();
    const tel = (qs('#pTel').value || '').trim();
    const mensaje = qs('#pMensaje').value.trim();
    const term = qs('#pTerminos')?.checked ?? true; // por seguridad

    if (!nombre || mensaje.length < 50 || !term) {
        alert('Completa nombre, mensaje (≥ 50) y acepta términos.'); return;
    }

    const app = {
        jobId: currentJob.id,
        jobTitle: currentJob.titulo,
        company: currentJob.empresa,
        owner: currentJob.owner,        // reclutador
        candidate: ses.correo,          // candidato
        candidateName: nombre,
        candidateEmail: correo || '',
        candidateTel: tel || '',
        candidateMessage: mensaje,
        createdAt: Date.now(),
        status: 'pendiente',
        message: '',
        unreadFor: currentJob.owner     // notifica a reclutador
    };

    try {
        await createApply(app);
        bootstrap.Modal.getInstance(qs('#postularModal'))?.hide();
        alert('Postulación enviada.');
    } catch (err) {
        console.error(err); alert('No se pudo enviar la postulación.');
    }
});

// Favoritos (Firestore subcolección)
async function toggleFavorite(jobId) {
    const ses = getSession(); if (!ses) { alert('Inicia sesión como Candidato para guardar favoritos.'); return; }
    try {
        await toggleFavoriteFB(ses.correo, jobId);
        renderPerfil();
    } catch (e) {
        console.error(e); alert('No se pudo actualizar favoritos.');
    }
}

// ===== Publicar / Editar (Reclutador) =====
function gatePublish() {
    const ses = getSession(); const ok = !!ses && ses.rol === 'reclutador';
    qs('#pubGate')?.classList.toggle('d-none', ok);
    qs('#frmPublicar')?.classList.toggle('d-none', !ok);
}

qs('#frmPublicar')?.addEventListener('submit', async e => {
    e.preventDefault();
    const ses = getSession(); if (!(ses && ses.rol === 'reclutador')) return alert('Inicia sesión como Reclutador.');

    const id = qs('#vId').value || null;
    const now = Date.now();
    const estadoId = qs('#vEstado').value;
    const municipio = qs('#vMunicipio').value;
    const estadoNombre = nombreEstadoById(estadoId);
    const ubicacion = municipio && estadoNombre ? `${municipio}, ${estadoNombre}` : estadoNombre;

    const job = {
        owner: ses.correo,
        titulo: qs('#vTitulo').value.trim(),
        empresa: qs('#vEmpresa').value.trim(),
        estadoId, estado: estadoNombre, municipio, ubicacion,
        tipo: qs('#vTipo').value,
        salario: parseInt(qs('#vSalario').value, 10) || 0,
        periodo: qs('#vPeriodo')?.value || 'Mensual',
        descripcion: qs('#vDescripcion').value.trim(),
        createdAt: now,
        status: 'publicada'
    };

    if (!job.titulo || !job.empresa || !job.estadoId || !job.municipio || !job.tipo || !job.salario || !job.descripcion)
        return alert('Completa todos los campos, incluyendo Estado y Municipio.');

    try {
        if (!id) {
            await createJob(job);
        } else {
            await updateJob(id, job);
        }
        alert('Vacante guardada.');
        (qs('#frmPublicar') || {}).reset?.();
        qs('#vId').value = '';
        fillEstados(qs('#vEstado'), false);
        qs('#vMunicipio').innerHTML = '<option value="">Selecciona municipio</option>'; qs('#vMunicipio').disabled = true;

        await loadJobs();
        renderPanel(); show('panel');
    } catch (err) {
        console.error(err); alert('No se pudo guardar la vacante.');
    }
});

qs('#btnLimpiarVacante')?.addEventListener('click', () => { (qs('#frmPublicar') || {}).reset?.(); qs('#vId').value = ''; });

// Cargar datos de una vacante al formulario (desde JOBS_CACHE)
function loadToForm(id) {
    const j = (JOBS_CACHE || []).find(x => x.id === id); if (!j) return;
    qs('#vId').value = j.id;
    qs('#vTitulo').value = j.titulo;
    qs('#vEmpresa').value = j.empresa;

    fillEstados(qs('#vEstado'), false);
    qs('#vEstado').value = j.estadoId || '';
    fillMunicipios(qs('#vMunicipio'), j.estadoId || '', false);
    qs('#vMunicipio').value = j.municipio || '';
    if (qs('#vUbicacion')) qs('#vUbicacion').value = j.ubicacion || [j.municipio, j.estado].filter(Boolean).join(', ');

    qs('#vTipo').value = j.tipo;
    qs('#vSalario').value = j.salario;
    if (qs('#vPeriodo')) qs('#vPeriodo').value = j.periodo || 'Mensual';
    qs('#vDescripcion').value = j.descripcion;
}

// ===== Panel (vacantes + apps) =====
function badgeFor(st) { return st === 'aceptado' ? 'success' : (st === 'rechazado' ? 'secondary' : 'primary'); }

async function renderPanel() {
    const ses = getSession(); if (!(ses && ses.rol === 'reclutador')) { show('home'); return; }
    const jobs = await getMyJobs(ses.correo);
    const pub = jobs.filter(j => j.status !== 'borrada');
    const del = jobs.filter(j => j.status === 'borrada');

    const rPub = qs('#panelPublicadas'); rPub.innerHTML = pub.length ? '' : '<div class="text-secondary">No tienes vacantes publicadas.</div>';
    pub.forEach(j => {
        const appsNum = j.appCount ?? 0; // opcional si guardas contador
        const item = document.createElement('div');
        item.className = 'p-2 border border-secondary rounded';
        item.innerHTML = `
  <div class="d-flex justify-content-between align-items-start gap-2">
    <div>
      <div class="fw-semibold">${j.titulo}</div>
      <div class="small text-secondary">
        ${j.empresa} • ${j.ubicacion || [j.municipio, j.estado].filter(Boolean).join(', ')} • ${j.tipo}
      </div>
      <div class="small text-secondary">
        📩 <a href="#" data-action="panel-open-apps" data-job="${j.id}" class="link-light text-decoration-underline">
        <span data-appcount="${j.id}">…</span> postulaciones</a> · ${fmtDate(j.createdAt)}
      </div>
    </div>
    <div class="d-flex flex-column gap-2">
      <div class="btn-group">
        <button class="btn btn-sm btn-outline-light" data-action="edit-job" data-id="${j.id}">Editar</button>
        <button class="btn btn-sm btn-outline-light" data-action="del-job" data-id="${j.id}">Borrar</button>
      </div>
    </div>
  </div>`;

        rPub.appendChild(item);
    });

    const rDel = qs('#panelBorradas'); if (rDel) {
        rDel.innerHTML = del.length ? '' : '<div class="text-secondary">No hay vacantes borradas.</div>';
        del.forEach(j => {
            const item = document.createElement('div');
            item.className = 'p-2 border border-secondary rounded';
            item.innerHTML = `
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div>
            <div class="fw-semibold">${j.titulo}</div>
            <div class="small text-secondary">${j.empresa} • ${j.ubicacion || [j.municipio, j.estado].filter(Boolean).join(', ')}</div>
            <div class="small text-secondary">Borrada</div>
          </div>
          <div class="btn-group">
            <!-- (Fase 2) restaurar/erase si lo migras -->
          </div>
        </div>`;
            rDel.appendChild(item);
        });
    }

    renderPanelApps();
}

qs('#appSearch')?.addEventListener('input', renderPanelApps);
qs('#appEstado')?.addEventListener('change', renderPanelApps);

// Listado de postulaciones del reclutador (Firebase)
async function renderPanelApps() {
    const ses = getSession(); if (!ses) return;
    const appsAll = await getAppliesByOwner(ses.correo);

    const q = (qs('#appSearch')?.value || '').toLowerCase();
    const f = qs('#appEstado')?.value || '';
    const onlyJob = qs('#appJobFilter')?.value || '';

    const list = appsAll.filter(a => {
        const hay = (a.jobTitle + ' ' + a.company + ' ' + (a.candidateName || '') + ' ' + (a.candidate || '')).toLowerCase().includes(q);
        const est = !f || a.status === f;
        const jf = !onlyJob || a.jobId === onlyJob;
        return hay && est && jf;
    });

    const c = qs('#panelApps'); c.innerHTML = list.length ? '' : '<div class="text-secondary">No hay postulaciones que coincidan.</div>';

    list.forEach(a => {
        const isNew = a.unreadFor === ses.correo;
        const badgeNew = isNew ? '<span class="badge bg-warning text-dark ms-2">Nuevo</span>' : '';
        const row = document.createElement('div');
        row.className = 'p-2 border border-secondary rounded';
        row.innerHTML = `
      <div class="d-flex justify-content-between align-items-start gap-2">
        <div>
          <div class="fw-semibold">${a.jobTitle} — ${a.company}${badgeNew}</div>
          <div class="small text-secondary">${a.candidateName || a.candidate} • ${fmtDate(a.createdAt)}</div>
          <div class="small">Estado: <span class="badge bg-${badgeFor(a.status)}">${a.status}</span></div>
        </div>
        <div class="d-flex flex-column gap-2">
          <div class="btn-group">
            <button class="btn btn-sm btn-outline-light" data-action="app-status" data-app-id="${a.id}" data-status="pendiente">Pendiente</button>
            <button class="btn btn-sm btn-outline-light" data-action="app-status" data-app-id="${a.id}" data-status="aceptado">Aceptar</button>
            <button class="btn btn-sm btn-outline-light" data-action="app-status" data-app-id="${a.id}" data-status="rechazado">Rechazar</button>
          </div>
          <button class="btn btn-sm btn-primary" data-action="app-view" data-app-id="${a.id}">Ver</button>
        </div>
      </div>`;
        c.appendChild(row);
    });
}

// Abrir listado filtrado al dar click en "X postulaciones" de una vacante
document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action="panel-open-apps"]'); if (!a) return;
    e.preventDefault();
    const jobId = a.getAttribute('data-job');
    const tabTrigger = document.querySelector('[data-bs-target="#tabPostulaciones"]');
    if (tabTrigger) new bootstrap.Tab(tabTrigger).show();
    qs('#appJobFilter').value = jobId;
    renderPanelApps();
});

// ===== Modal de una postulación: abrir / cambiar estado / responder =====
document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action="app-view"]'); if (!b) return;
    const appId = b.getAttribute('data-app-id');
    const ses = getSession(); if (!ses) return;
    const appsAll = await getAppliesByOwner(ses.correo);
    const a = appsAll.find(x => x.id === appId); if (!a) return;

    qs('#amJob').textContent = a.jobTitle;
    qs('#amCompany').textContent = a.company;
    qs('#amCandidate').textContent = a.candidateName || a.candidate || '—';
    qs('#amContact').textContent = [a.candidateEmail, a.candidateTel].filter(Boolean).join(' · ') || '—';
    qs('#amDate').textContent = fmtDate(a.createdAt);
    qs('#amUserMsg').textContent = a.candidateMessage || '—';
    qs('#amReply').value = a.message || '';
    qs('#amTemplate').value = '';
    qs('#amStatusGroup').setAttribute('data-app', a.id);

    // Marcar estado activo
    qs('#amStatusGroup')?.querySelectorAll('button').forEach(btn => {
        btn.classList.toggle('btn-primary', btn.dataset.status === a.status);
        btn.classList.toggle('btn-outline-light', btn.dataset.status !== a.status);
    });

    // Si era "Nuevo" para el reclutador, marcar como leído
    if (a.unreadFor === ses.correo) {
        await updateApply(a.id, { unreadFor: '' });
        renderPanelApps();
    }

    new bootstrap.Modal(qs('#appModal')).show();
});

// Cambiar estado dentro del modal (botones de estado)
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#amStatusGroup button[data-status]');
    if (!btn) return;

    const status = btn.dataset.status;
    const appId = qs('#amStatusGroup')?.getAttribute('data-app');
    if (!appId) return;

    try {
        await updateApply(appId, { status, unreadFor: 'candidate' });
        // Actualizar estilos de botones
        qs('#amStatusGroup')?.querySelectorAll('button').forEach(b => {
            b.classList.toggle('btn-primary', b.dataset.status === status);
            b.classList.toggle('btn-outline-light', b.dataset.status !== status);
        });
        renderPanelApps();
    } catch (err) {
        console.error(err);
        alert('No se pudo actualizar el estado de la postulación.');
    }
});

// Insertar plantilla en el textarea del modal
qs('#amInsertTemplate')?.addEventListener('click', () => {
    const tpl = qs('#amTemplate').value;
    if (!tpl) return;
    const box = qs('#amReply');
    const sep = box.value ? '\n' : '';
    box.value = box.value + sep + tpl;
});

// Enviar respuesta al candidato (marca “Nuevo” para el candidato)
qs('#btnGuardarRespuesta')?.addEventListener('click', async () => {
    const appId = qs('#amStatusGroup')?.getAttribute('data-app'); if (!appId) return;
    const msg = qs('#amReply').value.trim();

    try {
        await updateApply(appId, { message: msg, repliedAt: Date.now(), unreadFor: 'candidate' });
        alert('Respuesta enviada.');
        renderPanelApps();
        bootstrap.Modal.getInstance(qs('#appModal'))?.hide();
    } catch (err) { console.error(err); alert('No se pudo enviar la respuesta.'); }
});

// ===== Perfil =====
async function renderPerfil() {
    const ses = getSession(); if (!ses) { show('home'); return; }

    qs('#perfilInfo').innerHTML = `
    <div class="row g-3">
      <div class="col-md-6"><div class="small text-secondary">Rol</div><div class="h6">${ses.rol}</div></div>
      <div class="col-md-6"><div class="small text-secondary">Correo</div><div class="h6">${ses.correo}</div></div>
      ${ses.empresa ? `<div class="col-md-6"><div class="small text-secondary">Empresa</div><div class="h6">${ses.empresa}</div></div>` : ''}
    </div>`;

    // Favoritos (candidato)
    const favBox = qs('#boxFavoritos'); const favList = qs('#listaFavoritos');
    if (ses.rol === 'candidato') {
        try {
            const favIds = await getFavorites(ses.correo);
            const items = JOBS_CACHE
                .filter(j => favIds.includes(j.id))
                .map(j => {
                    const ubic = j.ubicacion || [j.municipio, j.estado].filter(Boolean).join(', ');
                    return `
            <div class="border-bottom py-2 d-flex justify-content-between align-items-center">
              <div>${j.titulo} — ${j.empresa} <span class="small text-secondary">(${ubic})</span></div>
              <div class="d-flex gap-2">
                <button class="btn btn-sm btn-outline-light" data-action="detalle" data-id="${j.id}" data-bs-toggle="modal" data-bs-target="#detalleModal">Ver</button>
              </div>
            </div>`;
                }).join('');
            favList.innerHTML = items || '<div class="text-secondary">No tienes favoritos.</div>';
            favBox.classList.remove('d-none');
        } catch (e) {
            console.error(e);
            favList.innerHTML = '<div class="text-secondary">No pudimos cargar favoritos.</div>';
            favBox.classList.remove('d-none');
        }
    } else {
        favBox?.classList.add('d-none');
    }

    // Mis postulaciones (candidato)
    const boxMis = qs('#boxMisPost'); const listaMis = qs('#listaMisPost');
    if (ses.rol === 'candidato') {
        try {
            const apps = await getAppliesByCandidate(ses.correo);
            listaMis.innerHTML = apps.length ? apps.map(a => {
                const isNew = a.unreadFor === 'candidate';
                const newBadge = isNew ? ' <span class="badge bg-warning text-dark ms-1">Nuevo</span>' : '';
                const replied = a.repliedAt ? ` • Respondido: ${fmtDate(a.repliedAt)}` : '';
                const motivo = a.message ? `<div class="small mt-1"><span class="badge badge-outline me-1">Respuesta</span> ${a.message}</div>` : '';
                return `
          <div class="border-bottom py-2">
            <div class="fw-semibold">${a.jobTitle} — ${a.company}${newBadge}</div>
            <div class="small text-secondary">
              ${fmtDate(a.createdAt)} • Estado: <span class="badge bg-${badgeFor(a.status)}">${a.status}</span>${replied}
            </div>
            ${motivo}
          </div>`;
            }).join('') : '<div class="text-secondary">Aún no te has postulado.</div>';
            boxMis.classList.remove('d-none');

            // Marcar como leídas si había nuevas para el candidato
            const porLeer = apps.filter(x => x.unreadFor === 'candidate');
            if (porLeer.length) await Promise.all(porLeer.map(x => updateApply(x.id, { unreadFor: '' })));
        } catch (e) {
            console.error(e);
            listaMis.innerHTML = '<div class="text-secondary">No pudimos cargar tus postulaciones.</div>';
            boxMis.classList.remove('d-none');
        }
    } else {
        boxMis?.classList.add('d-none');
    }
}

// ===== Auth (Firebase) =====
qs('#frmSignup')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rol = qs('#sRol').value;
    const email = qs('#sCorreo').value.trim();
    const pass = qs('#sPass').value;
    const empresa = (qs('#sEmpresa')?.value || '').trim();
    if (!email || pass.length < 8) return alert('Completa correo y contraseña (≥8).');

    try {
        await signUpEmail(email, pass, {});
        localStorage.setItem(SESSION_ROLE, rol);
        if (rol === 'reclutador') localStorage.setItem(SESSION_COMPANY, empresa);
        bootstrap.Modal.getInstance(qs('#signupModal'))?.hide();
        setTimeout(() => new bootstrap.Modal(qs('#loginModal')).show(), 150);
    } catch (err) {
        console.error(err); alert('No se pudo crear la cuenta.');
    }
});

qs('#frmLogin')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rol = qs('#lRol').value, correo = qs('#lCorreo').value.trim(), pass = qs('#lPass').value;
    try {
        await signInEmail(correo, pass);
        localStorage.setItem(SESSION_ROLE, rol);
        bootstrap.Modal.getInstance(qs('#loginModal'))?.hide();
        updateAuthUI();

        // Si venías de "Postularme"
        const pendRaw = localStorage.getItem('lejaPending');
        const pending = pendRaw ? JSON.parse(pendRaw) : null;
        if (pending?.type === 'apply' && pending.jobId) {
            localStorage.removeItem('lejaPending');
            const job = JOBS_CACHE.find(j => j.id === pending.jobId);
            if (job) {
                currentJob = job;
                const ubic = job.ubicacion || [job.municipio, job.estado].filter(Boolean).join(', ');
                qs('#detalleTitulo').textContent = job.titulo;
                qs('#detalleContenido').innerHTML = `
          <div class="mb-2">${job.empresa} • ${ubic}</div>
          <div class="mb-3">${job.tipo} • $${(job.salario || 0).toLocaleString('es-MX')} / ${job.periodo || 'Mensual'}</div>
          <pre style="white-space:pre-wrap">${job.descripcion || ''}</pre>`;
                new bootstrap.Modal(qs('#detalleModal')).show();
                return;
            }
        }
        // Flujo normal
        if (rol === 'reclutador') { show('panel'); renderPanel(); } else { show('vacantes'); }
    } catch (err) {
        console.error(err); alert('Credenciales incorrectas.');
    }
});

qs('#btnLogout')?.addEventListener('click', async () => {
    try {
        await signOutUser();
        localStorage.removeItem(SESSION_ROLE);
        localStorage.removeItem(SESSION_COMPANY);
        updateAuthUI(); show('home');
    } catch (e) {
        console.error(e); alert('No se pudo cerrar sesión.');
    }
});

// Escucha global de cambios de Auth
onAuth(() => {
    updateAuthUI();
    // refrescos suaves si ya estás en estas vistas
    const currentView = document.querySelector('.view.active');
    if (currentView === VIEWS.panel) renderPanel();
    if (currentView === VIEWS.perfil) renderPerfil();
});

// ===== Inicio =====
window.addEventListener('DOMContentLoaded', async () => {
    await loadMXCatalog();

    // Filtros (vacantes)
    fillEstados(qs('#fEstado'), true);
    qs('#fEstado')?.addEventListener('change', () => {
        const est = qs('#fEstado').value;
        fillMunicipios(qs('#fMunicipio'), est, true);
        qs('#fMunicipio').value = '';
    });

    // Publicar (form)
    fillEstados(qs('#vEstado'), false);
    qs('#vEstado')?.addEventListener('change', () => {
        const est = qs('#vEstado').value;
        fillMunicipios(qs('#vMunicipio'), est, false);
        qs('#vMunicipio').value = '';
        updateUbicacionPreview();
    });
    qs('#vMunicipio')?.addEventListener('change', updateUbicacionPreview);

    updateAuthUI();
    await loadJobs();           // carga vacantes públicas desde Firestore
    show('home');
});

function updateUbicacionPreview() {
    const estId = qs('#vEstado')?.value || '';
    const mun = qs('#vMunicipio')?.value || '';
    const estNom = nombreEstadoById(estId);
    if (qs('#vUbicacion')) {
        qs('#vUbicacion').value = mun && estNom ? `${mun}, ${estNom}` : (estNom || '');
    }
}
