import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Subject, catchError, interval, of, switchMap, tap } from 'rxjs';
import { API, ApiService, Contrato, Lista, Sesion, Stats } from '../../../core/api';
import { IconComponent } from '../../../shared/icon.component';

import { ActivatedRoute } from '@angular/router';
import { AuthService } from '../../../core/auth.service';
import { TiempoRealService } from '../../../core/tiempo-real.service';
import {
  AsigContrato, AsignacionesService, ESTADOS_ASIG, EstadoAsig, Miembro,
} from '../asignaciones/asignaciones.service';

type TipoVisor = 'pdf' | 'imagen' | 'otro';
interface Visor { nombre: string; url: string; tipo: TipoVisor; }
interface Est { tipo: 'ok' | 'warn' | 'danger' | 'off'; label: string; valor: string; }
interface Chip { label: string; value: string; }

const PAGE_SIZE = 24;

@Component({
  selector: 'app-menor',
  imports: [IconComponent],
  templateUrl: './contrataciones.page.html',
  styleUrl: './contrataciones.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'onEscape()' },
})
export class ContratacionesPage {
  private readonly api: ApiService = inject(ApiService);
  private readonly sanitizer: DomSanitizer = inject(DomSanitizer);
readonly auth: AuthService = inject(AuthService);
  private readonly asigApi: AsignacionesService = inject(AsignacionesService);
  private readonly route: ActivatedRoute = inject(ActivatedRoute);
  private readonly rt: TiempoRealService = inject(TiempoRealService);

  // ---- Filtros ----
  readonly tipos: { label: string; value: string }[] = [
    { label: 'Todos', value: '' },
    { label: 'Bienes', value: 'Bien' },
    { label: 'Servicios', value: 'Servicio' },
    { label: 'Obras', value: 'Obra' },
    { label: 'Consultoría', value: 'Consult' },
  ];
  private readonly q = signal<string>('');
  private readonly estado = signal<string>('2');
  private readonly relevante = signal<boolean>(false);
  readonly objeto = signal<string>('');

  // ---- Estado ----
  readonly lista = signal<Lista | null>(null);
  readonly stats = signal<Stats | null>(null);
  readonly page = signal<number>(1);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string>('');
  readonly sel = signal<Contrato | null>(null);
  readonly visor = signal<Visor | null>(null);
  readonly sesion = signal<Sesion | null>(null);
  readonly iniciandoSesion = signal<boolean>(false);
readonly errorSesion = signal<string>('');

  // ---- Asignación del contrato abierto ----
  readonly equipo = signal<Miembro[]>([]);
  readonly asigsContrato = signal<AsigContrato[]>([]);
  readonly asigQuien = signal<string>('');
  readonly asigNota = signal<string>('');
  readonly asignando = signal<boolean>(false);
  readonly errorAsig = signal<string>('');

  readonly totalPages = computed<number>(() =>
    Math.max(1, Math.ceil((this.lista()?.total ?? 0) / PAGE_SIZE)));

  readonly statsList = computed<Chip[]>(() => {
    const s = this.stats();
    if (!s) return [];
    const fmt = (n: number): string => n.toLocaleString('es-PE');
    return [
      { label: 'Total', value: fmt(s.total) },
      { label: 'Mis categorías', value: fmt(s.relevantes) },
      { label: 'Vigentes', value: fmt(s.por_estado['2'] ?? 0) },
      { label: 'En evaluación', value: fmt(s.por_estado['3'] ?? 0) },
    ];
  });

  readonly visorUrl = computed<SafeResourceUrl | null>(() => {
    const v = this.visor();
    return v && v.tipo === 'pdf' ? this.sanitizer.bypassSecurityTrustResourceUrl(v.url) : null;
  });

  // Cada llamada cancela la anterior (evita que resultados viejos pisen a los nuevos)
  private readonly load$ = new Subject<void>();

constructor() {
    // Si llegas desde "Mis asignaciones" (?abrir=ID), se abre el detalle directamente
    const abrirId = Number(this.route.snapshot.queryParamMap.get('abrir'));
    if (abrirId > 0) {
          const previa = (history.state?.['contrato'] ?? null) as Partial<Contrato> | null;
          const base = previa?.id_contrato === abrirId ? previa : {};
          this.abrir({ ...base, id_contrato: abrirId } as Contrato);
        }

    // Tiempo real: si cambian las asignaciones del contrato abierto, se refrescan solas
    this.rt.eventos.pipe(takeUntilDestroyed()).subscribe(() => {
      const s = this.sel();
      if (s) this.cargarAsignacionesContrato(s.id_contrato);
    });
    this.api.stats().subscribe({
      next: (s: Stats) => this.stats.set(s),
      error: () => {},
    });

    this.load$
      .pipe(
        tap(() => {
          this.loading.set(true);
          this.error.set('');
        }),
        switchMap(() =>
          this.api.contratos(this.params()).pipe(
            catchError(() => {
              this.error.set('No se pudo conectar con el servidor. Verifica que el backend esté activo.');
              return of<Lista | null>(null);
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((res: Lista | null) => {
        this.loading.set(false);
        if (res) this.lista.set(res);
      });

    // Bloquea el scroll del fondo mientras haya drawer o modal abierto
    effect(() => {
      document.body.style.overflow = this.sel() || this.visor() ? 'hidden' : '';
    });

// Refresca la lista y las estadísticas cada 5 minutos
    interval(5 * 60 * 1000)
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.load$.next();
        this.api.stats().subscribe({ next: (s: Stats) => this.stats.set(s), error: () => {} });
      });

    // Estado de la sesión SEACE: al abrir y cada 30 s
    this.cargarSesion();
    interval(30_000).pipe(takeUntilDestroyed()).subscribe(() => this.cargarSesion());

    this.load$.next();
  }

  private params(): Record<string, string | number | boolean> {
    const p: Record<string, string | number | boolean> = {
      page: this.page(),
      page_size: PAGE_SIZE,
    };
    if (this.q().trim()) p['q'] = this.q().trim();
    if (this.estado() !== '') p['estado'] = this.estado();
    if (this.objeto()) p['objeto'] = this.objeto();
    if (this.relevante()) p['relevante'] = true;
    return p;
  }

  private recargar(resetPage = true): void {
    if (resetPage) this.page.set(1);
    this.load$.next();
  }

  // ---- Acciones de filtros ----
  buscar(texto: string): void { this.q.set(texto); this.recargar(); }
  setEstado(v: string): void { this.estado.set(v); this.recargar(); }
  setRelevante(v: boolean): void { this.relevante.set(v); this.recargar(); }
  setObjeto(v: string): void { this.objeto.set(v); this.recargar(); }

  ir(delta: number): void {
    const nueva = this.page() + delta;
    if (nueva < 1 || nueva > this.totalPages()) return;
    this.page.set(nueva);
    this.recargar(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---- Detalle (drawer) ----
  abrir(c: Contrato): void {
this.sel.set({ ...c, archivos: undefined });
    this.errorAsig.set('');
    this.cargarAsignacionesContrato(c.id_contrato);
    this.api.detalle(c.id_contrato).subscribe({
      next: (d: Contrato) => {
        if (this.sel()?.id_contrato === d.id_contrato) this.sel.set(d);
      },
      error: () => {
        if (this.sel()?.id_contrato === c.id_contrato) this.sel.set({ ...c, archivos: [] });
      },
    });
  }

  cerrar(): void {
    this.sel.set(null);
    this.visor.set(null);
  }

// ---- Asignaciones (solo quien puede cotizar) ----
  private cargarAsignacionesContrato(id: number): void {
    if (!this.auth.puede('menor:cotizar')) return;
    this.asigApi.deContrato(id).subscribe({
      next: (l: AsigContrato[]) => { if (this.sel()?.id_contrato === id) this.asigsContrato.set(l); },
      error: () => this.asigsContrato.set([]),
    });
    if (!this.equipo().length) {
      this.asigApi.equipo().subscribe({ next: (e: Miembro[]) => this.equipo.set(e), error: () => undefined });
    }
  }

  asignar(): void {
    const c = this.sel();
    const para = Number(this.asigQuien());
    if (!c || this.asignando()) return;
    if (!para) { this.errorAsig.set('Elige a quién asignar'); return; }
    this.asignando.set(true);
    this.errorAsig.set('');
    this.asigApi.crear({ id_contrato: c.id_contrato, asignado_a: para, nota: this.asigNota().trim() || null }).subscribe({
      next: () => {
        this.asignando.set(false);
        this.asigQuien.set('');
        this.asigNota.set('');
        this.cargarAsignacionesContrato(c.id_contrato);
      },
      error: (e: any) => {
        this.asignando.set(false);
        this.errorAsig.set(typeof e?.error?.detail === 'string' ? e.error.detail : 'No se pudo asignar');
      },
    });
  }

  estadoNombre(e: EstadoAsig): string { return ESTADOS_ASIG[e] ?? e; }

  // ---- Visor de documentos (modal) ----
private esMovil(): boolean {
  return (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.platform)) // iPad con iPadOS
  );
}

abrirArchivo(a: any): void {
  const nombre = this.archivoNombre(a);
  const url = this.archivoUrl(a);
  const tipo = this.tipoArchivo(nombre);

  // Word, Excel, etc.: se descarga y lo abre el programa del equipo
  if (tipo === 'otro') {
    window.location.href = url;
    return;
  }
  // PDF en móvil: pestaña nueva
  if (tipo === 'pdf' && this.esMovil()) {
    window.open(url, '_blank');
    return;
  }
  this.visor.set({ nombre, url, tipo });
}


  cerrarVisor(): void { this.visor.set(null); }

    // ---- Sesión SEACE (usa las credenciales del .env del backend) ----
  private cargarSesion(): void {
    this.api.sesion().subscribe({
      next: (s: Sesion) => this.sesion.set(s),
      error: () => this.sesion.set(null),
    });
  }

  iniciarSesionErp(): void {
    if (this.iniciandoSesion()) return;
    this.iniciandoSesion.set(true);
    this.errorSesion.set('');
    this.api.iniciarSesion().subscribe({
      next: (s: Sesion) => {
        this.sesion.set(s);
        this.iniciandoSesion.set(false);
      },
      error: (e: any) => {
        this.errorSesion.set(e?.error?.detail ?? 'No se pudo iniciar sesión');
        this.iniciandoSesion.set(false);
      },
    });
  }

  // Escape: primero cierra el modal del documento, luego el drawer
  onEscape(): void {
    if (this.visor()) this.cerrarVisor();
    else if (this.sel()) this.cerrar();
  }

  private tipoArchivo(nombre: string): TipoVisor {
    const ext = nombre.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'pdf') return 'pdf';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'imagen';
    return 'otro';
  }

  // ---- Helpers de presentación ----
  tipoLabel(c: Contrato): string { return c.objeto || 'Sin tipo'; }

  private parse(s: string | null | undefined): Date | null {
    if (!s) return null;
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d;
  }

  fecha(s: string | null | undefined): string {
    const d = this.parse(s);
    if (!d) return s || '—';
    return d.toLocaleString('es-PE', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  disponible(c: Contrato): boolean {
    if (c.id_estado !== 2) return false;
    const ini = this.parse(c.fec_ini_cot);
    const fin = this.parse(c.fec_fin_cot);
    const ahora = new Date();
    if (ini && ini > ahora) return false;
    if (fin && fin < ahora) return false;
    return true;
  }

  est(c: Contrato): Est {
    if (c.id_estado !== 2) return { tipo: 'off', label: 'Estado', valor: c.estado };
    const ahora = new Date();
    const ini = this.parse(c.fec_ini_cot);
    const fin = this.parse(c.fec_fin_cot);
    if (ini && ini > ahora) return { tipo: 'warn', label: 'Inicia', valor: this.fecha(c.fec_ini_cot) };
    if (!fin) return { tipo: 'ok', label: 'Estado', valor: c.estado };
    const ms = fin.getTime() - ahora.getTime();
    if (ms <= 0) return { tipo: 'danger', label: 'Estado', valor: 'Vencido' };
    const horas = Math.floor(ms / 3_600_000);
    const dias = Math.floor(horas / 24);
    if (dias >= 1) {
      return { tipo: dias <= 2 ? 'warn' : 'ok', label: 'Quedan', valor: `${dias} ${dias === 1 ? 'día' : 'días'}` };
    }
    return {
      tipo: 'danger',
      label: 'Quedan',
      valor: horas >= 1 ? `${horas} h` : `${Math.max(1, Math.floor(ms / 60_000))} min`,
    };
  }

  // ---- Archivos (AJUSTAR según tu archivos.py) ----
// ---- Archivos ----
archivoId(a: any): string | number {
  return a?.idContratoArchivo;
}

archivoNombre(a: any): string {
  return a?.nombre ?? 'archivo.pdf';
}

  archivoUrl(a: any): string {
    const t = encodeURIComponent(this.auth.token() ?? '');
    return `${API}/archivo/${this.archivoId(a)}?nombre=${encodeURIComponent(this.archivoNombre(a))}&token=${t}`;
  }
}