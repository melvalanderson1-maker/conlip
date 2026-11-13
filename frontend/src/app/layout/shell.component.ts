import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { TiempoRealService } from '../core/tiempo-real.service';
import { IconComponent } from '../shared/icon.component';
import { CampanaComponent } from '../features/anuncios/campana.component';

import { ServiciosMenuService } from '../features/cuenta/servicios-menu.service';
import { CrmFlagService } from '../features/crm/crm.service';

const MODULOS = [
  { id: 'menor', label: 'Coti Menor' },
  { id: 'mayor', label: 'Coti Mayor' },
  { id: 'perucompras', label: 'Perú Compras' },
];
const MENU = [
  { ruta: 'contrataciones', label: 'Contrataciones', permiso: 'ver' },
  { ruta: 'capacitacion', label: 'Capacitación', permiso: 'ver' },
  { ruta: 'servicios', label: 'Servicios', permiso: 'ver' },
  { ruta: 'asignaciones', label: 'Mis asignaciones', permiso: 'cotizar' },
];
const ROLES: Record<string, string> = {
  superadmin: 'Superadmin', admin: 'Administrador', cotizador: 'Cotizador', visualizador: 'Visualizador', asesor: 'Asesor', ejecutivo: 'Ejecutivo de ventas',
};

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent, CampanaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="top">
      <div class="brand"><span class="logo">C</span><b>COTI</b></div>
      <nav class="modulos">
        @if ((auth.esEjecutivo() || auth.esAsesor()) && crm.activo()) {
          <button type="button" class="mod" [class.on]="enMiCrm()" (click)="irMiCrm()">Mi CRM</button>
        }
        @if (auth.esAsesor()) {
          <button type="button" class="mod" [class.on]="enMiAgenda()" (click)="irMiAgenda()">Mi agenda</button>
        }
        @for (m of modulosVisibles(); track m.id) {
          <button type="button" class="mod" [class.on]="modulo() === m.id" (click)="ir(m.id)">
            {{ m.label }}
            @if (m.id === 'menor' && rt.sinVer() > 0) { <span class="num">{{ rt.sinVer() > 99 ? '99+' : rt.sinVer() }}</span> }
          </button>
        }
        @if (auth.esAdmin()) {
          <button type="button" class="mod" [class.on]="enAdmin()" (click)="irAdmin()">Administración</button>
        }
        @if (auth.esSuperadmin()) {
          <button type="button" class="mod" [class.on]="enPlataforma()" (click)="irPlataforma()">Plataforma</button>
          <button type="button" class="mod" [class.on]="enCatalogo()" (click)="irCatalogo()">Catálogo</button>
          <button type="button" class="mod" [class.on]="enPedidos()" (click)="irPedidos()">Pedidos</button>
          <button type="button" class="mod" [class.on]="enCursos()" (click)="irCursos()">Cursos</button>
          <button type="button" class="mod" [class.on]="enAnuncios()" (click)="irAnuncios()">Anuncios</button>
          <button type="button" class="mod" [class.on]="enAgenda()" (click)="irAgenda()">Agenda</button>
          <button type="button" class="mod" [class.on]="enLegal()" (click)="irLegal()">Legal</button>
          <button type="button" class="mod" [class.on]="enAvisos()" (click)="irAvisos()">Avisos</button>
          <button type="button" class="mod" [class.on]="enVentas()" (click)="irVentas()">Ventas</button>
          @if (crm.activo()) { <button type="button" class="mod" [class.on]="enCrm()" (click)="irCrm()">CRM</button> }
        }
      </nav>
      <div class="user">
        <app-campana />
        <span>{{ auth.usuario()?.nombre || auth.usuario()?.usuario }}</span>
        <span class="rol">{{ rolNombre() }}</span>
        @if (auth.esTitular()) {
          <button type="button" class="cuentabtn" [class.act]="enCuenta()" (click)="irCuenta()">
            <app-icon name="user" [size]="14" /> Mi cuenta
          </button>
        }
        <button type="button" class="cuentabtn" [class.act]="enSeguridad()" (click)="irSeguridad()">
          <app-icon name="lock" [size]="14" /> Seguridad
        </button>
        <button type="button" class="salir" (click)="salir()">Salir</button>
      </div>
    </header>

    <div class="cuerpo">
      @if (enAdmin()) {
        <aside class="lateral">
          <small>Administración</small>
          <a routerLink="/admin/usuarios" routerLinkActive="on">Usuarios</a>
        </aside>
      } @else if (modulo() && !enReproductor()) {
        <aside class="lateral">
          <small>{{ nombreModulo() }}</small>
          @for (i of menuModulo(); track i.ruta) {
            @if (i.bloqueado) {
              <a class="bloq" [routerLink]="auth.esTitular() ? ['/cuenta'] : null"
                 [attr.title]="'Requiere el modo Visualizar y cotizar. ' + (auth.esTitular() ? 'Mejora tu plan en Mi cuenta.' : 'Pídeselo al administrador de tu cuenta.')">
                {{ i.label }} <app-icon name="lock" [size]="14" />
              </a>
            } @else {
              <a [routerLink]="['/', modulo(), i.ruta]" routerLinkActive="on">
                {{ i.label }}
                @if (i.ruta === 'asignaciones' && modulo() === 'menor' && rt.sinVer() > 0) {
                  <span class="num">{{ rt.sinVer() > 99 ? '99+' : rt.sinVer() }}</span>
                }
              </a>
            }
          }
        </aside>
      }
      <section class="contenido"><router-outlet /></section>
    </div>

    <div class="toasts" aria-live="polite">
      @for (t of rt.toasts(); track t.id) {
        <button type="button" class="toast" (click)="abrirAsignaciones(t.id)">
          <b>Nueva asignación</b>
          <span>{{ t.texto }}</span>
        </button>
      }
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: #f5f6fa; color: #0f172a;
      font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; }
    * { box-sizing: border-box; }
    .top { position: sticky; top: 0; z-index: 30; height: 57px; display: flex; align-items: center; gap: 20px;
      padding: 0 20px; background: #fff; border-bottom: 1px solid #e6e8f0; }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 1.1rem; }
    .logo { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; color: #fff;
      font-weight: 700; background: linear-gradient(135deg, #6366f1, #4338ca); }
    .modulos { display: flex; gap: 8px; flex: 1; overflow-x: auto; }
    .mod { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; border: 1px solid #e6e8f0;
      background: #fff; color: #64748b; font: inherit; font-size: .9rem; font-weight: 500; cursor: pointer; white-space: nowrap; transition: .15s; }
    .mod:hover { color: #0f172a; border-color: #c7cbe0; }
    .mod.on { background: #4f46e5; border-color: #4f46e5; color: #fff; }
    .num { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px;
      background: #ef4444; color: #fff; font-size: .7rem; font-weight: 700; line-height: 1; }
    .user { display: flex; align-items: center; gap: 12px; font-size: .88rem; color: #64748b; white-space: nowrap; }
    .rol { padding: 3px 10px; border-radius: 999px; background: #eef0ff; color: #4f46e5; font-size: .75rem; font-weight: 600; }
    .salir { padding: 6px 14px; border-radius: 8px; border: 1px solid #e6e8f0; background: #fff; font: inherit; cursor: pointer; }
    .salir:hover { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
    .cuentabtn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 8px; border: 1px solid #e6e8f0;
      background: #fff; color: #475569; font: inherit; cursor: pointer; transition: .15s; }
    .cuentabtn:hover, .cuentabtn.act { background: #eef0ff; border-color: #c7cbe0; color: #4f46e5; }
    .cuerpo { display: flex; align-items: flex-start; }
    .lateral { position: sticky; top: 57px; width: 220px; flex: none; display: flex; flex-direction: column; gap: 4px;
      padding: 20px 14px; min-height: calc(100vh - 57px); background: #fff; border-right: 1px solid #e6e8f0; }
    .lateral small { margin: 0 10px 8px; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; color: #64748b; }
    .lateral a { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-radius: 10px;
      color: #475569; text-decoration: none; font-size: .92rem; font-weight: 500; }
    .lateral a:hover { background: #f1f2f8; color: #0f172a; }
    .lateral a.on { background: #eef0ff; color: #4f46e5; }
    .lateral a.bloq { color: #94a3b8; cursor: default; }
    .lateral a.bloq[href] { cursor: pointer; }
    .lateral a.bloq:hover { background: #f8fafc; color: #64748b; }
    .contenido { flex: 1; min-width: 0; }
    .toasts { position: fixed; right: 16px; bottom: 16px; z-index: 90; display: flex; flex-direction: column; gap: 8px; }
    .toast { display: flex; flex-direction: column; gap: 2px; min-width: 260px; max-width: 360px; padding: 12px 16px; text-align: left;
      border: 0; border-left: 4px solid #4f46e5; border-radius: 12px; background: #fff; color: #0f172a; font: inherit; cursor: pointer;
      box-shadow: 0 12px 32px -12px rgb(15 23 42 / .35); animation: entra .25s cubic-bezier(.2, .8, .2, 1); }
    .toast span { font-size: .85rem; color: #475569; }
    @keyframes entra { from { transform: translateY(12px); opacity: 0; } }
    @media (max-width: 760px) {
      .top { height: auto; flex-wrap: wrap; padding: 10px 14px; gap: 10px; }
      .modulos { order: 3; flex-basis: 100%; }
      .cuerpo { flex-direction: column; }
      .lateral { position: static; width: 100%; min-height: 0; flex-direction: row; flex-wrap: wrap; align-items: center;
        padding: 10px 14px; border-right: 0; border-bottom: 1px solid #e6e8f0; }
      .lateral small { display: none; }
      .toasts { left: 16px; }
    }
  `],
})
export class ShellComponent implements OnInit {
  readonly auth: AuthService = inject(AuthService);
  readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly router: Router = inject(Router);

  private readonly url = toSignal(
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map(() => this.router.url)),
    { initialValue: this.router.url },
  );

  private readonly seccion = computed<string>(() => this.url().split('?')[0].split('/')[1] ?? '');
  readonly enAdmin = computed<boolean>(() => this.seccion() === 'admin');
  readonly enPlataforma = computed<boolean>(() => this.seccion() === 'plataforma');
  readonly enCatalogo = computed<boolean>(() => this.seccion() === 'catalogo');
  readonly enPedidos = computed<boolean>(() => this.seccion() === 'pedidos');
  readonly enCursos = computed<boolean>(() => this.seccion() === 'cursos-admin');
  readonly enAnuncios = computed<boolean>(() => this.seccion() === 'anuncios-admin');
  readonly enAgenda = computed<boolean>(() => this.seccion() === 'agenda-admin');
  readonly enMiAgenda = computed<boolean>(() => this.seccion() === 'mi-agenda');
  readonly enLegal = computed<boolean>(() => this.seccion() === 'legal-admin');
  readonly enAvisos = computed<boolean>(() => this.seccion() === 'avisos-admin');
  readonly enVentas = computed<boolean>(() => this.seccion() === 'ventas-admin');
  readonly enCrm = computed<boolean>(() => this.seccion() === 'crm-admin');
  readonly enMiCrm = computed<boolean>(() => this.seccion() === 'mi-crm');
  readonly enSeguridad = computed<boolean>(() => this.seccion() === 'seguridad');
  /** Dentro de un curso el menú lateral se oculta para dar espacio al reproductor. */
  readonly enReproductor = computed<boolean>(() => {
    const p = this.url().split('?')[0].split('/');
    return p.length >= 4 && p[2] === 'capacitacion';
  });
  readonly enCuenta = computed<boolean>(() => this.seccion() === 'cuenta');
  readonly modulo = computed<string>(() => (MODULOS.some((x) => x.id === this.seccion()) ? this.seccion() : ''));
  readonly nombreModulo = computed<string>(() => MODULOS.find((x) => x.id === this.modulo())?.label ?? '');
  readonly modulosVisibles = computed(() => MODULOS.filter((m) => this.auth.puede(`${m.id}:ver`)));
  private readonly menuServ: ServiciosMenuService = inject(ServiciosMenuService);
  readonly crm: CrmFlagService = inject(CrmFlagService);
  /** "Servicios" aparece solo si el superadmin lo habilitó para este módulo y el usuario es titular. */
  readonly verServicios = computed<boolean>(() => !!this.menuServ.habilitados()[this.modulo()]);

  /** Todas las opciones del módulo; las que el plan no incluye salen bloqueadas (con candado). */
  readonly menuModulo = computed(() =>
    MENU.filter((i) => i.ruta !== 'servicios' || this.verServicios())
          .map((i) => ({ ...i, bloqueado: i.ruta !== 'servicios' && !this.auth.puede(`${this.modulo()}:${i.permiso}`) })));
  readonly rolNombre = computed<string>(() => ROLES[this.auth.usuario()?.rol ?? ''] ?? '');

  ngOnInit(): void {
    // Sincroniza rol y permisos con el servidor y, recién entonces, abre el tiempo real
    this.auth.refrescar().subscribe({
      next: () => { this.rt.iniciar(); this.menuServ.cargar(); this.crm.cargar(); },
      error: () => undefined, // un 401 lo maneja el interceptor
    });
  }

  ir(id: string): void { this.router.navigate(['/', id]); }
  irAdmin(): void { this.router.navigate(['/admin', 'usuarios']); }
  irPlataforma(): void { this.router.navigate(['/plataforma']); }
  irCatalogo(): void { this.router.navigate(['/catalogo']); }
  irPedidos(): void { this.router.navigate(['/pedidos']); }
  irCursos(): void { this.router.navigate(['/cursos-admin']); }
  irAnuncios(): void { this.router.navigate(['/anuncios-admin']); }
  irAgenda(): void { this.router.navigate(['/agenda-admin']); }
  irMiAgenda(): void { this.router.navigate(['/mi-agenda']); }
  irLegal(): void { this.router.navigate(['/legal-admin']); }
  irAvisos(): void { this.router.navigate(['/avisos-admin']); }
  irVentas(): void { this.router.navigate(['/ventas-admin']); }
  irCrm(): void { this.router.navigate(['/crm-admin']); }
  irMiCrm(): void { this.router.navigate(['/mi-crm']); }
  irSeguridad(): void { this.router.navigate(['/seguridad']); }
  irCuenta(): void { this.router.navigate(['/cuenta']); }

  abrirAsignaciones(idToast: number): void {
    this.rt.cerrarToast(idToast);
    this.router.navigate(['/menor', 'asignaciones']);
  }

  salir(): void {
    this.rt.detener();
    this.auth.salir();
    this.router.navigate(['/login']);
  }
}