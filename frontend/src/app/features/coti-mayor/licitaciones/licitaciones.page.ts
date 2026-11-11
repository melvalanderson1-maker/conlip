import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Subject, Subscription, catchError, interval, of, switchMap, tap } from 'rxjs';
import { API } from '../../../core/api';
import { IconComponent } from '../../../shared/icon.component';

interface Proceso {
  ocid: string; nomenclatura: string; titulo: string | null; descripcion: string | null;
  entidad: string; modalidad: string; categoria: string | null;
  fecha_convocatoria: string | null; monto: number | null; moneda: string | null;
  primera_vez: string; n_docs: number; etapa_actual: string | null;
  detalle?: any; documentos?: any[] | null; cronograma?: any[] | null;
  estado_calc?: string; adjudicaciones?: any[] | null;
  fuente?: string; ganador?: string | null; ficha_en?: string | null; items?: any[] | null;
  proximo_hito?: string | null; proximo_hito_etapa?: string | null;
}

type TipoVisor = 'pdf' | 'imagen' | 'otro';
type TabId = 'resumen' | 'cronograma' | 'documentos' | 'items' | 'postores';
interface Visor { nombre: string; url: string; tipo: TipoVisor; formato: string; }
interface PostoresResp {
  ocid: string; estado: string; paso: string | null; error: string | null;
  total_postores: number | null; postor_actual: number | null; postores: any[];
}
interface ListaP { total: number; items: Proceso[]; }
interface StatsP { total: number; hoy: number; por_modalidad: Record<string, number>; por_estado?: Record<string, number>; }
interface Chip { label: string; value: string; }

interface Cambio { id: number; ocid: string; nomenclatura?: string | null; entidad?: string | null; tipo: string; detalle: any; creado_en: string; }
interface HistorialResp { ultimo_id: number; items: Cambio[]; }

const PAGE_SIZE = 24;

@Component({
  selector: 'app-licitaciones',
  imports: [IconComponent],
  templateUrl: './licitaciones.page.html',
  styleUrls: ['../../coti-menor/contrataciones/contrataciones.page.css', './licitaciones.page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'onEscape()' },
})
export class LicitacionesPage {
  private readonly http: HttpClient = inject(HttpClient);

  private readonly sanitizer: DomSanitizer = inject(DomSanitizer);
  readonly visor = signal<Visor | null>(null);
  readonly abriendoDoc = signal<number | null>(null);
  readonly errorDoc = signal<string>('');
 readonly cargandoNombre = signal<string>('');
  private docSub: Subscription | null = null;
    readonly fmtReal = signal<Record<string, string>>({});
      readonly postores = signal<PostoresResp | null>(null);
  readonly postorAbierto = signal<number | null>(null);
  readonly errorPost = signal<string>('');
  private postSub: Subscription | null = null;
      private readonly destroyRef: DestroyRef = inject(DestroyRef);
  private versionVista = '';
  private totalVisto = 0;
  private avisoTimer: ReturnType<typeof setTimeout> | null = null;
  readonly ultimaAct = signal<Date | null>(null);
  readonly avisoNuevas = signal<number>(0);

  private ultimoCambioId: number | null = null;
  private avisoCambiosTimer: ReturnType<typeof setTimeout> | null = null;
  readonly cambiados = signal<Set<string>>(new Set());
  readonly historialSel = signal<Cambio[]>([]);
  readonly avisoCambios = signal<string>('');
  readonly horaAct = computed<string>(() =>
    this.ultimaAct()?.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) ?? '');
  readonly visorUrl = computed<SafeResourceUrl | null>(() => {
    const v = this.visor();
    return v && v.tipo === 'pdf' ? this.sanitizer.bypassSecurityTrustResourceUrl(v.url) : null;
  });

  readonly modalidades: { label: string; value: string }[] = [
    { label: 'Todas', value: '' },
    { label: 'Licitación Pública', value: 'Licitación Pública' },
    { label: 'Lic. Abreviada', value: 'Licitación Pública Abreviada' },
    { label: 'Concurso Servicios', value: 'Concurso Público de Servicios' },
    { label: 'Concurso Consultoría', value: 'Concurso Público para Consultoría' },
    { label: 'Subasta Inversa', value: 'Subasta Inversa Electrónica' },
  ];

  private readonly q = signal<string>('');
  readonly modalidad = signal<string>('');

    readonly estadoSel = signal<string>('');
      readonly orden = signal<string>('recientes');
  readonly publicadoDias = signal<number>(0);
  readonly categoria = signal<string>('');
  readonly montoMin = signal<string>('');
  readonly montoMax = signal<string>('');
  readonly tab = signal<TabId>('resumen');
  readonly copiado = signal<boolean>(false);
  readonly ordenes: { label: string; value: string }[] = [
    { label: 'Más recientes publicadas', value: 'recientes' },
    { label: 'Más antiguas publicadas', value: 'antiguas' },
    { label: 'Vencen primero (próximo cierre)', value: 'vence_pronto' },
    { label: 'Vencen al final (cierre más lejano)', value: 'vence_tarde' },
    { label: 'Agregadas últimamente al sistema', value: 'nuevas' },
    { label: 'Mayor valor referencial', value: 'monto_mayor' },
    { label: 'Menor valor referencial', value: 'monto_menor' },
  ];
  readonly rangos: { label: string; value: number }[] = [
    { label: 'Cualquier fecha', value: 0 },
    { label: 'Últimas 24 horas', value: 1 },
    { label: 'Últimos 7 días', value: 7 },
    { label: 'Últimos 30 días', value: 30 },
    { label: 'Últimos 90 días', value: 90 },
  ];
  readonly categorias: { label: string; value: string }[] = [
    { label: 'Todas las categorías', value: '' },
    { label: 'Bienes', value: 'goods' },
    { label: 'Servicios', value: 'services' },
    { label: 'Obras', value: 'works' },
    { label: 'Consultoría de obra', value: 'consultoriadeobra' },
  ];
  readonly filtrosActivos = computed<number>(() =>
    [this.orden() !== 'recientes', this.publicadoDias() > 0, !!this.categoria(), !!this.montoMin(),
     !!this.montoMax(), !!this.estadoSel(), !!this.modalidad()].filter(Boolean).length);
  readonly estados: { label: string; value: string }[] = [
    { label: 'Todos los estados', value: '' },
    { label: 'Vigentes', value: 'vigente' },
    { label: 'Por iniciar', value: 'por_iniciar' },
    { label: 'Adjudicadas', value: 'adjudicado' },
    { label: 'Posible desierto', value: 'desierto' },
    { label: 'Concluidas', value: 'concluido' },
    { label: 'Por verificar', value: 'sin_estado' },
  ];
  readonly lista = signal<ListaP | null>(null);
  readonly stats = signal<StatsP | null>(null);
  readonly page = signal<number>(1);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string>('');
  readonly sel = signal<Proceso | null>(null);

  readonly totalPages = computed<number>(() =>
    Math.max(1, Math.ceil((this.lista()?.total ?? 0) / PAGE_SIZE)));

  readonly statsList = computed<Chip[]>(() => {
    const s = this.stats();
    if (!s) return [];
    const fmt = (n: number): string => n.toLocaleString('es-PE');
    return [
      { label: 'Total licitaciones', value: fmt(s.total) },
      { label: 'Nuevas (24 h)', value: fmt(s.hoy) },
      { label: 'Vigentes', value: fmt(s.por_estado?.['vigente'] ?? 0) },
      { label: 'Adjudicadas', value: fmt(s.por_estado?.['adjudicado'] ?? 0) },
    ];
  });

  private readonly load$ = new Subject<void>();

  constructor() {
    this.cargarStats();

    this.load$.pipe(
      tap(() => { this.loading.set(true); this.error.set(''); }),
      switchMap(() =>
        this.http.get<ListaP>(`${API}/mayor/procesos`, { params: this.params() }).pipe(
          catchError(() => {
            this.error.set('No se pudo conectar con el servidor.');
            return of<ListaP | null>(null);
          }),
        ),
      ),
      takeUntilDestroyed(),
    ).subscribe((res: ListaP | null) => {
      this.loading.set(false);
      if (res) this.lista.set(res);
    });

    effect(() => { document.body.style.overflow = this.sel() ? 'hidden' : ''; });

    // En vivo: cada 15 s pregunta si hubo cambios (consulta liviana) y recarga solo si los hay
    this.revisarCambios();
    interval(15_000).pipe(takeUntilDestroyed()).subscribe(() => this.revisarCambios());
    const alVolver = (): void => { if (!document.hidden) this.revisarCambios(); };
    document.addEventListener('visibilitychange', alVolver);
    this.destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', alVolver));

    this.load$.next();
  }

    private revisarCambios(): void {
    if (document.hidden) return;
    this.revisarHistorial();
    this.http.get<{ total: number; version: string }>(`${API}/mayor/cambios`).subscribe({
      next: (c: { total: number; version: string }) => {
        this.ultimaAct.set(new Date());
        if (!this.versionVista) {            // primera consulta: solo fija la referencia
          this.versionVista = c.version;
          this.totalVisto = c.total;
          return;
        }
        if (c.version === this.versionVista) return;
        const nuevas = c.total - this.totalVisto;
        this.versionVista = c.version;
        this.totalVisto = c.total;
        this.load$.next();
        this.cargarStats();
        this.refrescarDetalle();
        if (nuevas > 0) this.mostrarAviso(nuevas);
      },
      error: () => undefined,
    });
  }


    /** Pregunta por cambios reales (documento nuevo, cronograma reprogramado, etapa nueva). */
  private revisarHistorial(): void {
    const desde = this.ultimoCambioId;
    const params: Record<string, string | number> = desde === null ? {} : { desde_id: desde };
    this.http.get<HistorialResp>(`${API}/mayor/historial`, { params }).subscribe({
      next: (r: HistorialResp) => {
        if (desde === null) { this.ultimoCambioId = r.ultimo_id; return; }   // primera vez: solo referencia
        this.ultimoCambioId = r.ultimo_id;
        if (!r.items.length) return;
        this.cambiados.update((s) => {
          const n = new Set(s);
          for (const c of r.items) n.add(c.ocid);
          return n;
        });
        this.load$.next();
        this.cargarStats();
        this.refrescarDetalle();
        this.mostrarAvisoCambios(r.items);
      },
      error: () => undefined,
    });
  }

  private mostrarAvisoCambios(items: Cambio[]): void {
    this.avisoCambios.set(items.length === 1
      ? `${items[0].nomenclatura ?? 'Licitación'}: ${this.cambioTexto(items[0])}`
      : `${items.length} actualizaciones detectadas en el SEACE`);
    if (this.avisoCambiosTimer) clearTimeout(this.avisoCambiosTimer);
    this.avisoCambiosTimer = setTimeout(() => this.avisoCambios.set(''), 8000);
  }

  private cargarHistorialSel(ocid: string): void {
    this.http.get<{ items: Cambio[] }>(`${API}/mayor/procesos/${encodeURIComponent(ocid)}/historial`).subscribe({
      next: (r: { items: Cambio[] }) => { if (this.sel()?.ocid === ocid) this.historialSel.set(r.items); },
      error: () => undefined,
    });
  }

  cambioTexto(c: Cambio): string {
    const d = c.detalle ?? {};
    switch (c.tipo) {
      case 'documento_nuevo': return `Documento nuevo: ${d.documento || d.nombre_archivo || ''}`.trim();
      case 'etapa_nueva': return `Etapa nueva en el cronograma: ${d.etapa ?? ''}`;
      case 'cronograma_fecha': return `Cambió la fecha de la etapa «${d.etapa ?? ''}»`;
      case 'etapa_actual': return `Ahora está en la etapa «${d.etapa ?? ''}»`;
      default: return c.tipo;
    }
  }


  /** Si hay un drawer abierto, trae de nuevo sus datos (cronograma, documentos, URLs) sin cerrarlo. */
  private refrescarDetalle(): void {
    const s = this.sel();
    if (!s) return;
    this.cargarHistorialSel(s.ocid);
    this.http.get<Proceso>(`${API}/mayor/procesos/${encodeURIComponent(s.ocid)}`).subscribe({
      next: (d: Proceso) => {
        const act = this.sel();
        if (act && act.ocid === d.ocid) this.sel.set({ ...act, ...d });
      },
      error: () => undefined,
    });
  }

  private mostrarAviso(n: number): void {
    this.avisoNuevas.set(n);
    if (this.avisoTimer) clearTimeout(this.avisoTimer);
    this.avisoTimer = setTimeout(() => this.avisoNuevas.set(0), 8000);
  }

  private cargarStats(): void {
    this.http.get<StatsP>(`${API}/mayor/stats`).subscribe({
      next: (s: StatsP) => this.stats.set(s),
      error: () => undefined,
    });
  }

  private params(): Record<string, string | number> {
    const p: Record<string, string | number> = { page: this.page(), page_size: PAGE_SIZE };
    if (this.q().trim()) p['q'] = this.q().trim();
    if (this.modalidad()) p['modalidad'] = this.modalidad();
    if (this.estadoSel()) p['estado'] = this.estadoSel();
    if (this.orden() !== 'recientes') p['orden'] = this.orden();
    if (this.publicadoDias() > 0) p['publicado_dias'] = this.publicadoDias();
    if (this.categoria()) p['categoria'] = this.categoria();
    if (this.montoMin() !== '' && !isNaN(Number(this.montoMin()))) p['monto_min'] = Number(this.montoMin());
    if (this.montoMax() !== '' && !isNaN(Number(this.montoMax()))) p['monto_max'] = Number(this.montoMax());
    return p;
  }

  private recargar(reset = true): void {
    if (reset) this.page.set(1);
    this.load$.next();
  }

  buscar(texto: string): void { this.q.set(texto); this.recargar(); }
  setModalidad(v: string): void { this.modalidad.set(v); this.recargar(); }
    setEstadoFiltro(v: string): void { this.estadoSel.set(v); this.recargar(); }
      setOrden(v: string): void { this.orden.set(v); this.recargar(); }
  setPublicado(v: string): void { this.publicadoDias.set(Number(v) || 0); this.recargar(); }
  setCategoria(v: string): void { this.categoria.set(v); this.recargar(); }
  setMonto(cual: 'min' | 'max', v: string): void {
    (cual === 'min' ? this.montoMin : this.montoMax).set(v.trim());
    this.recargar();
  }

  limpiarFiltros(): void {
    this.orden.set('recientes');
    this.publicadoDias.set(0);
    this.categoria.set('');
    this.montoMin.set('');
    this.montoMax.set('');
    this.estadoSel.set('');
    this.modalidad.set('');
    this.recargar();
  }

  setTab(t: TabId): void { this.tab.set(t); }

  actualizando(): boolean {
    const e = this.postores()?.estado;
    return e === 'en_cola' || e === 'en_progreso';
  }

  categoriaLabel(c: string | null | undefined): string {
    const m: Record<string, string> = {
      goods: 'Bienes', services: 'Servicios', works: 'Obras', consultoriadeobra: 'Consultoría de obra',
    };
    return m[c ?? ''] ?? (c ?? '');
  }

  estadoAyuda(code: string | undefined | null): string {
    const m: Record<string, string> = {
      vigente: 'El cronograma está en marcha: hay etapas abiertas o por cerrarse.',
      por_iniciar: 'La entidad ya convocó el proceso, pero su primera etapa todavía no empieza.',
      adjudicado: 'Ya hay una adjudicación (buena pro) registrada para este proceso.',
      desierto: 'Se detectaron documentos que indican que el proceso podría haberse declarado desierto.',
      concluido: 'El cronograma terminó y no hay adjudicación registrada.',
      sin_estado: 'Todavía no se leyó la ficha del SEACE; el estado se confirmará en la próxima lectura.',
    };
    return m[code ?? ''] ?? m['sin_estado'];
  }

  /** Próxima fecha límite del cronograma (la etapa que cierra primero). */
  hito(d: Proceso): { etapa: string; fin: string } | null {
    const ahora = new Date();
    let mejor: any = null;
    let t = Infinity;
    for (const c of d.cronograma ?? []) {
      const f = this.aFecha(c?.fecha_fin);
      if (f && f > ahora && f.getTime() < t) { mejor = c; t = f.getTime(); }
    }
    return mejor ? { etapa: mejor.etapa, fin: mejor.fecha_fin } : null;
  }

  restante(s: string | null | undefined): string {
    const d = this.aFecha(s);
    if (!d) return '';
    const ms = d.getTime() - Date.now();
    if (ms <= 0) return 'venció';
    const min = Math.floor(ms / 60_000);
    const dias = Math.floor(min / 1440);
    const horas = Math.floor((min % 1440) / 60);
    if (dias >= 1) return `quedan ${dias} d ${horas} h`;
    if (horas >= 1) return `quedan ${horas} h ${min % 60} min`;
    return `quedan ${Math.max(1, min)} min`;
  }

  hace(s: string | null | undefined): string {
    const d = this.aFecha(s);
    if (!d) return 'todavía no';
    const min = Math.floor((Date.now() - d.getTime()) / 60_000);
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    if (min < 1440) return `hace ${Math.floor(min / 60)} h`;
    return `hace ${Math.floor(min / 1440)} d`;
  }

  copiar(t: string): void {
    navigator.clipboard?.writeText(t).then(() => {
      this.copiado.set(true);
      setTimeout(() => this.copiado.set(false), 1800);
    }).catch(() => undefined);
  }

  estadoLabel(code: string | undefined | null): string {
    const m: Record<string, string> = {
      vigente: 'Vigente', por_iniciar: 'Por iniciar', adjudicado: 'Adjudicado',
      desierto: 'Posible desierto', concluido: 'Concluido sin resultado', sin_estado: 'Por verificar',
    };
    return m[code ?? ''] ?? 'Por verificar';
  }

  montoAdj(a: any): string {
    if (a?.monto == null) return '—';
    return `${a.moneda ?? ''} ${Number(a.monto).toLocaleString('es-PE', { minimumFractionDigits: 2 })}`.trim();
  }

  ir(delta: number): void {
    const nueva = this.page() + delta;
    if (nueva < 1 || nueva > this.totalPages()) return;
    this.page.set(nueva);
    this.recargar(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  abrir(p: Proceso): void {
    this.detenerPostores();
    this.postores.set(null);
    this.postorAbierto.set(null);
    this.errorPost.set('');
    this.tab.set('resumen');
    if (this.esFinalizada(p.estado_calc) || !p.ficha_en) this.iniciarPostores(p.ocid, false);
    this.sel.set(p);
    this.historialSel.set([]);
    this.cargarHistorialSel(p.ocid);
    this.http.get<Proceso>(`${API}/mayor/procesos/${encodeURIComponent(p.ocid)}`).subscribe({
      next: (d: Proceso) => {
        if (this.sel()?.ocid === d.ocid) {
          this.sel.set({ ...p, ...d });
          this.centrarLinea();
        }
      },
      error: () => undefined,
    });
  }

  cerrar(): void {
    this.cancelarDocumento();
    this.cerrarVisor();
    this.errorDoc.set('');
    this.detenerPostores();
    this.postores.set(null);
    this.sel.set(null);
  }

  onEscape(): void {
    if (this.abriendoDoc() !== null) this.cancelarDocumento();
    else if (this.visor()) this.cerrarVisor();
    else this.cerrar();
  }

  /** Formato del documento: el real (si ya se abrió) > el guardado > el que sale en el nombre. */
  formatoDe(x: any, i: number): string {
    const real = this.fmtReal()[`${this.sel()?.ocid}:${i}`];
    if (real) return real;
    const f = (x?.formato ?? '').toString().toUpperCase();
    if (f) return f === 'JPEG' ? 'JPG' : f;
    for (const t of [x?.nombre_archivo, x?.archivo, x?.documento]) {
      const m = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|png|jpe?g|gif|txt|csv|xml)\b/i.exec((t ?? '').toString());
      if (m) {
        const e = m[1].toUpperCase();
        return e === 'JPEG' ? 'JPG' : e;
      }
    }
    return '';
  }

  fmtClase(fm: string): string {
    if (fm === 'PDF') return 'fmt-pdf';
    if (['DOC', 'DOCX'].includes(fm)) return 'fmt-word';
    if (['XLS', 'XLSX', 'CSV'].includes(fm)) return 'fmt-excel';
    if (['ZIP', 'RAR', '7Z'].includes(fm)) return 'fmt-zip';
    if (['PNG', 'JPG', 'GIF'].includes(fm)) return 'fmt-img';
    return '';
  }

  private aFecha(s: string | null | undefined): Date | null {
    if (!s) return null;
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d;
  }

  fechaDia(s: string | null | undefined): string {
    const d = this.aFecha(s);
    return d ? d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  }

  hora(s: string | null | undefined): string {
    const d = this.aFecha(s);
    return d ? d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '';
  }

  /** Estado de una etapa según sus fechas (la marca del SEACE solo se usa si no hay fechas). */
  estadoEtapa(c: any): 'hecha' | 'actual' | 'pendiente' {
    const ahora = new Date();
    const ini = this.aFecha(c?.fecha_inicio);
    const fin = this.aFecha(c?.fecha_fin);
    if (!ini && !fin) return c?.es_etapa_actual ? 'actual' : 'pendiente';
    if (fin && fin < ahora) return 'hecha';
    if (ini && ini <= ahora && (!fin || fin >= ahora)) return 'actual';
    return 'pendiente';
  }

  progreso(d: Proceso): { hechas: number; total: number; pct: number; actual: string } {
    const cr: any[] = d.cronograma ?? [];
    const total = cr.length;
    const hechas = cr.filter((c) => this.estadoEtapa(c) === 'hecha').length;
    const act = cr.find((c) => this.estadoEtapa(c) === 'actual');
    return { hechas, total, pct: total ? Math.round((hechas / total) * 100) : 0, actual: act?.etapa ?? '' };
  }

  private centrarLinea(): void {
    setTimeout(() => {
      document.querySelector('.panel-mayor .tl-item.actual')
        ?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }, 150);
  }

  abrirDocumento(i: number, x: any): void {
    const p = this.sel();
    if (!p || this.abriendoDoc() !== null) return;
    const nombre: string = x?.nombre_archivo || x?.documento || 'documento';
    this.abriendoDoc.set(i);
    this.cargandoNombre.set(nombre);
    this.errorDoc.set('');
    this.docSub = this.http
      .get(`${API}/mayor/procesos/${encodeURIComponent(p.ocid)}/documentos/${i}`, { responseType: 'blob' })
      .subscribe({
        next: async (blob: Blob) => {
          try {
            const r = await this.analizar(blob, nombre);
            this.cerrarVisor();
            if (r.formato) this.fmtReal.update((m) => ({ ...m, [`${p.ocid}:${i}`]: r.formato }));
            this.visor.set({ nombre: r.nombre, url: URL.createObjectURL(r.blob), tipo: r.tipo, formato: r.formato });
          } finally {
            this.abriendoDoc.set(null);
            this.docSub = null;
          }
        },
        error: (e: any) => {
          this.abriendoDoc.set(null);
          this.docSub = null;
          const msgs: Record<number, string> = {
            404: 'Este documento todavía no tiene enlace. El scraper lo completa en su próximo ciclo.',
            401: 'Tu sesión venció. Vuelve a iniciar sesión.',
            403: 'No tienes permiso para ver este documento.',
            413: 'El archivo es demasiado grande para la vista previa.',
            502: 'SEACE no entregó el archivo. Reintenta en unos minutos.',
          };
          this.errorDoc.set(msgs[e?.status] ?? 'No se pudo abrir el documento.');
        },
      });
  }

  cancelarDocumento(): void {
    this.docSub?.unsubscribe();
    this.docSub = null;
    this.abriendoDoc.set(null);
  }

  cerrarVisor(): void {
    const v = this.visor();
    if (v) URL.revokeObjectURL(v.url);
    this.visor.set(null);
  }

  /** Detecta el formato real leyendo los primeros bytes (no confía en el nombre ni en el Content-Type). */
  private async analizar(blob: Blob, nombre: string): Promise<{ blob: Blob; tipo: TipoVisor; formato: string; nombre: string }> {
    const b = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const txt = String.fromCharCode(...b);
    const ext = (nombre.split('.').pop() ?? '').toLowerCase();
    let formato = '';
    let mime = blob.type;

    if (txt.startsWith('%PDF')) { formato = 'PDF'; mime = 'application/pdf'; }
    else if (b[0] === 0x89 && txt.slice(1, 4) === 'PNG') { formato = 'PNG'; mime = 'image/png'; }
    else if (b[0] === 0xff && b[1] === 0xd8) { formato = 'JPG'; mime = 'image/jpeg'; }
    else if (txt.startsWith('GIF8')) { formato = 'GIF'; mime = 'image/gif'; }
    else if (txt.startsWith('PK')) { formato = ['docx', 'xlsx', 'pptx'].includes(ext) ? ext.toUpperCase() : 'ZIP'; }
    else if (b[0] === 0xd0 && b[1] === 0xcf) { formato = ['doc', 'xls', 'ppt'].includes(ext) ? ext.toUpperCase() : 'DOC'; }
    else if (txt.startsWith('Rar!')) { formato = 'RAR'; }
    else if (b[0] === 0x37 && b[1] === 0x7a) { formato = '7Z'; }
    else { formato = ext.length >= 2 && ext.length <= 4 ? ext.toUpperCase() : ''; }

    const tipo: TipoVisor = formato === 'PDF' ? 'pdf' : ['PNG', 'JPG', 'GIF'].includes(formato) ? 'imagen' : 'otro';
    const conExt = /\.[A-Za-z0-9]{2,5}$/.test(nombre) ? nombre : (formato ? `${nombre}.${formato.toLowerCase()}` : nombre);
    return { blob: mime !== blob.type ? new Blob([blob], { type: mime }) : blob, tipo, formato, nombre: conExt };
  }

  fuenteLabel(f: string | undefined | null): string {
    return f === 'ambos' ? 'Sync + Live' : f === 'sync' ? 'Sync API' : 'Live SEACE';
  }

  fuenteTitulo(f: string | undefined | null): string {
    return f === 'ambos' ? 'Datos de la API y ficha leída en el SEACE'
      : f === 'sync' ? 'Solo datos de la API OCDS; la ficha aún no fue leída'
      : 'Leído directo del buscador del SEACE';
  }

  esFinalizada(e: string | undefined | null): boolean {
    return e === 'adjudicado' || e === 'concluido' || e === 'desierto';
  }

  num(v: any, dec = 2): string {
    if (v === null || v === undefined || v === '') return '—';
    const n = Number(v);
    return isNaN(n) ? String(v) : n.toLocaleString('es-PE', { minimumFractionDigits: dec, maximumFractionDigits: Math.max(dec, 2) });
  }

  esGanador(po: any, d: Proceso): boolean {
    const norm = (s: any): string =>
      (s ?? '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const ruc = norm(po?.ruc);
    const nombre = norm(po?.razon_social);
    return (d.adjudicaciones ?? []).some((a: any) =>
      (!!ruc && norm(a?.proveedor_ruc) === ruc) || (!!nombre && norm(a?.proveedor) === nombre));
  }

  togglePostor(id: number): void { this.postorAbierto.set(this.postorAbierto() === id ? null : id); }

  reintentarPostores(): void {
    const s = this.sel();
    if (s) this.iniciarPostores(s.ocid, true);
  }

  private iniciarPostores(ocid: string, forzar: boolean): void {
    this.detenerPostores();
    this.http.post<PostoresResp>(
      `${API}/mayor/procesos/${encodeURIComponent(ocid)}/postores/actualizar`, {}, { params: forzar ? { forzar: true } : {} },
    ).subscribe({
      next: (r: PostoresResp) => {
        if (this.sel()?.ocid !== ocid) return;
        this.postores.set(r);
        this.seguirPostores(ocid, r);
      },
      error: () => undefined,
    });
  }

  private seguirPostores(ocid: string, r: PostoresResp): void {
    if (r.estado !== 'en_cola' && r.estado !== 'en_progreso') return;
    this.detenerPostores();
    this.postSub = interval(3000).pipe(
      switchMap(() => this.http.get<PostoresResp>(`${API}/mayor/procesos/${encodeURIComponent(ocid)}/postores`)),
    ).subscribe({
      next: (x: PostoresResp) => {
        if (this.sel()?.ocid !== ocid) { this.detenerPostores(); return; }
        this.postores.set(x);
        if (x.estado !== 'en_cola' && x.estado !== 'en_progreso') {
          this.detenerPostores();
          this.refrescarDetalle();   // trae el cronograma, documentos y RUC ya guardados
          this.load$.next();
          this.cargarStats();
        }
      },
      error: () => this.detenerPostores(),
    });
  }

  private detenerPostores(): void {
    this.postSub?.unsubscribe();
    this.postSub = null;
  }

  abrirDocPostor(poId: number, j: number, x: any): void {
    const p = this.sel();
    if (!p || this.abriendoDoc() !== null) return;
    const nombre: string = x?.nombre_archivo || x?.nombre || 'documento';
    this.abriendoDoc.set(-1);
    this.cargandoNombre.set(nombre);
    this.errorPost.set('');
    this.docSub = this.http
      .get(`${API}/mayor/procesos/${encodeURIComponent(p.ocid)}/postores/${poId}/documentos/${j}`, { responseType: 'blob' })
      .subscribe({
        next: async (blob: Blob) => {
          try {
            const r = await this.analizar(blob, nombre);
            this.cerrarVisor();
            this.visor.set({ nombre: r.nombre, url: URL.createObjectURL(r.blob), tipo: r.tipo, formato: r.formato });
          } finally {
            this.abriendoDoc.set(null);
            this.docSub = null;
          }
        },
        error: (e: any) => {
          this.abriendoDoc.set(null);
          this.docSub = null;
          this.errorPost.set(e?.status === 404
            ? 'Este documento no tiene enlace disponible.'
            : 'No se pudo abrir el documento. SEACE no lo entregó; prueba de nuevo en unos minutos.');
        },
      });
  }

  esNuevo(p: Proceso): boolean {
    const t = new Date(p.primera_vez).getTime();
    return !isNaN(t) && Date.now() - t < 24 * 3_600_000;
  }

  fecha(s: string | null | undefined): string {
    if (!s) return '—';
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
    return isNaN(d.getTime()) ? s : d.toLocaleString('es-PE', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  monto(p: Proceso): string {
    if (p.monto == null) return '—';
    return `${p.moneda ?? ''} ${Number(p.monto).toLocaleString('es-PE', { minimumFractionDigits: 2 })}`.trim();
  }
}