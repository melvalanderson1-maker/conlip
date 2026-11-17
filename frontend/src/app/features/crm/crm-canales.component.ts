import { ChangeDetectionStrategy, Component, OnInit, WritableSignal, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';
import { ActivosMeta, CanalCrm, EstadoCanales, WhatsappService } from './crm-whatsapp.service';

const TIPOS: { id: CanalCrm['tipo']; label: string }[] = [
  { id: 'whatsapp', label: 'WhatsApp' }, { id: 'facebook', label: 'Messenger (Facebook)' }, { id: 'instagram', label: 'Instagram' },
];
const ESTADOS: Record<string, string> = { activo: 'Activo', error: 'Con error', desconectado: 'Desconectado' };

@Component({
  selector: 'app-crm-canales',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mensaje()) { <p class="ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
    @if (error()) { <p class="error"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

    @if (est(); as e) {
      <section class="card">
        <h3>1. Tu app de Meta (una sola vez)</h3>
        <p class="nota">Copia el App ID desde Meta → tu app → Configuración → Básica. El App Secret se guarda en Conexiones → tarjeta de WhatsApp.</p>
        <div class="chips">
          <span class="tag" [class.si]="!!e.app_id">App ID: {{ e.app_id ? 'guardado' : 'falta' }}</span>
          <span class="tag" [class.si]="e.app_secret_guardado">App Secret: {{ e.app_secret_guardado ? 'guardado' : 'falta' }}</span>
        </div>
        <div class="grid2">
          <label>App ID <input inputmode="numeric" [value]="appId()" (input)="appId.set($any($event.target).value)" /></label>
          <label>Configuration ID (solo si tu app usa Facebook Login for Business)
            <input inputmode="numeric" [value]="configId()" (input)="configId.set($any($event.target).value)" />
          </label>
        </div>
        <p class="nota">En Meta → Facebook Login → Configuración, agrega esta dirección en «URI de redireccionamiento de OAuth válidos»:
          <b class="url">{{ e.redirect_uri }}</b>
          <button type="button" class="btn" (click)="copiar(e.redirect_uri)">Copiar</button></p>
        <div class="fila acciones"><button type="button" class="btn primary" (click)="guardarApp()">Guardar</button></div>
      </section>

      <section class="card">
        <h3>2. Conectar canales</h3>
        <p class="nota">Con Meta eliges tus páginas de Facebook, tus cuentas de Instagram y tus números de WhatsApp en una sola pantalla. También puedes pegar el token permanente de tu usuario del sistema para traer todos los números de una cuenta de WhatsApp.</p>
        <div class="fila">
          <button type="button" class="btn primary" [disabled]="ocupado()" (click)="conectarMeta()">Conectar con Meta</button>
          <button type="button" class="btn" (click)="abrirToken()">Agregar números de WhatsApp con token</button>
        </div>
      </section>

      @for (t of tipos; track t.id) {
        <section class="card">
          <h3>{{ t.label }}</h3>
          @for (c of delTipo(t.id); track c.id) {
            <article class="canal">
              <div class="c-t">
                <b>{{ c.nombre }}</b>
                <small>{{ c.detalle || c.ext_id }}@if (c.legado) { · viene de Conexiones }</small>
                @if (c.estado === 'error' && c.error) { <small class="rojo">{{ c.error }}</small> }
              </div>
              <span class="tag" [class.si]="c.estado === 'activo'" [class.aviso]="c.estado === 'error'">{{ estadoTxt(c.estado) }}</span>
              <div class="fila">
                <button type="button" class="btn" [disabled]="ocupado()" (click)="probar(c)">Probar</button>
                <button type="button" class="btn" (click)="renombrar(c)">Renombrar</button>
                @if (!c.legado) { <button type="button" class="btn peligro" (click)="desconectar(c)">Desconectar</button> }
              </div>
            </article>
          } @empty { <p class="nota">Todavía no hay canales de este tipo.</p> }
        </section>
      }
    } @else { <p class="nota">Cargando…</p> }

    @if (activos(); as a) {
      <div class="overlay" (click)="cerrarSel()">
        <div class="modal ancho" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab"><h3>Elige qué conectar</h3>
            <button type="button" class="btn ico" aria-label="Cerrar" (click)="cerrarSel()"><app-icon name="x" [size]="18" /></button></header>
          @for (av of a.avisos; track $index) { <p class="nota aviso-t">{{ av }}</p> }

          @if (a.paginas.length) {
            <h4>Páginas de Facebook y cuentas de Instagram</h4>
            @for (p of a.paginas; track p.id) {
              <div class="item">
                <label class="chk">
                  <input type="checkbox" [checked]="selPag().includes(p.id) || p.conectada" [disabled]="p.conectada" (change)="alternar(selPag, p.id, $any($event.target).checked)" />
                  <span><b>{{ p.nombre }}</b> <small>Messenger{{ p.conectada ? ' · ya conectada' : '' }}</small></span>
                </label>
                @if (p.ig) {
                  <label class="chk sub">
                    <input type="checkbox" [checked]="selIg().includes(p.ig.id) || p.ig_conectada" [disabled]="p.ig_conectada || !(selPag().includes(p.id) || p.conectada)" (change)="alternar(selIg, p.ig.id, $any($event.target).checked)" />
                    <span>Instagram: {{ p.ig.usuario }}{{ p.ig_conectada ? ' · ya conectada' : '' }}</span>
                  </label>
                }
              </div>
            }
          }

          @if (a.numeros.length) {
            <h4>Números de WhatsApp</h4>
            @for (n of a.numeros; track n.id) {
              <div class="item">
                <label class="chk">
                  <input type="checkbox" [checked]="selNum().includes(n.id) || n.conectada" [disabled]="n.conectada" (change)="alternar(selNum, n.id, $any($event.target).checked)" />
                  <span><b>{{ n.numero }}</b> <small>{{ n.nombre }} · cuenta {{ n.waba || n.waba_id }}{{ n.calidad ? ' · calidad ' + n.calidad : '' }}{{ n.conectada ? ' · ya conectado' : '' }}</small></span>
                </label>
              </div>
            }
          }

          @if (!a.paginas.length && !a.numeros.length) {
            <p class="nota">Meta no devolvió páginas ni números. Revisa que tu usuario tenga rol en la app y que hayas aceptado los permisos sobre las páginas y la cuenta de WhatsApp.</p>
          }
          <div class="pie">
            <button type="button" class="btn" (click)="cerrarSel()">Cancelar</button>
            <button type="button" class="btn primary" [disabled]="ocupado() || !haySeleccion()" (click)="conectarSel()">Conectar seleccionados</button>
          </div>
        </div>
      </div>
    }

    @if (modalToken()) {
      <div class="overlay" (click)="modalToken.set(false)">
        <div class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab"><h3>Números de WhatsApp con token</h3>
            <button type="button" class="btn ico" aria-label="Cerrar" (click)="modalToken.set(false)"><app-icon name="x" [size]="18" /></button></header>
          <p class="nota">Usa el token permanente de tu usuario del sistema (Meta Business → Usuarios del sistema → Generar token, vencimiento «Nunca», con whatsapp_business_management y whatsapp_business_messaging) y el ID de la cuenta de WhatsApp Business.</p>
          <label>ID de la cuenta de WhatsApp Business <input inputmode="numeric" [value]="wabaId()" (input)="wabaId.set($any($event.target).value)" /></label>
          <label>Token <input type="password" autocomplete="off" [value]="tokenWa()" (input)="tokenWa.set($any($event.target).value)" /></label>
          <div class="pie">
            <button type="button" class="btn" (click)="modalToken.set(false)">Cancelar</button>
            <button type="button" class="btn primary" [disabled]="ocupado()" (click)="usarToken()">Ver mis números</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [ESTILOS_ADMIN, `
    .chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
    .tag { padding: 2px 10px; border-radius: 999px; background: #e8edf8; color: #334155; font-size: .74rem; font-weight: 600; } .tag.si { background: #dcfce7; color: #047857; } .tag.aviso { background: #fef3c7; color: #b45309; }
    .url { word-break: break-all; margin: 0 6px; }
    .canal { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 14px; margin-top: 10px; border: 1px solid var(--line); border-radius: 14px; background: #fff; }
    .c-t { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; } .c-t small { color: var(--muted); } .rojo { color: #b91c1c !important; }
    .modal.ancho { width: min(720px, 100%); } .m-cab { display: flex; justify-content: space-between; align-items: center; }
    .item { padding: 8px 0; border-bottom: 1px solid #f0f3fa; } .sub { margin: 6px 0 0 28px; }
    .chk { display: flex; flex-direction: row; align-items: flex-start; gap: 10px; font-weight: 500; cursor: pointer; } .chk input { width: 18px; height: 18px; margin-top: 2px; accent-color: var(--brand); }
    .chk small { color: var(--muted); } .aviso-t { color: #b45309; }
  `],
})
export class CrmCanalesComponent implements OnInit {
  private readonly api: WhatsappService = inject(WhatsappService);
  readonly tipos = TIPOS;

  readonly est = signal<EstadoCanales | null>(null);
  readonly appId = signal<string>('');
  readonly configId = signal<string>('');
  readonly activos = signal<ActivosMeta | null>(null);
  readonly selPag = signal<string[]>([]);
  readonly selIg = signal<string[]>([]);
  readonly selNum = signal<string[]>([]);
  readonly modalToken = signal<boolean>(false);
  readonly wabaId = signal<string>('');
  readonly tokenWa = signal<string>('');
  readonly ocupado = signal<boolean>(false);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  private sid = '';

  ngOnInit(): void {
    // Al volver de Meta, la dirección trae ?canales=ok&sid=... (o canales=error&msg=...)
    const p = new URLSearchParams(location.search);
    const resultado = p.get('canales');
    const sid = p.get('sid');
    if (resultado === 'error') this.falla(p.get('msg') || 'No se pudo completar la conexión con Meta');
    if (resultado) history.replaceState(null, '', location.pathname);
    this.cargar();
    if (sid) this.abrirSesion(sid);
  }

  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private falla(t: string): void { this.mensaje.set(''); this.error.set(t); }
  private fallo(e: HttpErrorResponse): void {
    const d = e.error?.detail;
    this.falla(typeof d === 'string' ? d : 'No se pudo conectar con el servidor');
  }

  delTipo(t: CanalCrm['tipo']): CanalCrm[] { return (this.est()?.canales ?? []).filter((c) => c.tipo === t); }
  estadoTxt(e: string): string { return ESTADOS[e] ?? e; }
  haySeleccion(): boolean { return this.selPag().length + this.selNum().length > 0; }

  cargar(): void {
    this.api.canales().subscribe({
      next: (r) => { this.est.set(r); this.appId.set(r.app_id); this.configId.set(r.config_id); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  copiar(t: string): void {
    navigator.clipboard.writeText(t).then(() => this.ok('Copiado'), () => this.falla('No se pudo copiar. Selecciónalo y cópialo a mano.'));
  }

  guardarApp(): void {
    this.api.guardarApp({ app_id: this.appId().trim(), config_id: this.configId().trim() }).subscribe({
      next: () => { this.ok('Datos de la app guardados'); this.cargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  conectarMeta(): void {
    this.ocupado.set(true);
    this.api.iniciarOauth().subscribe({
      next: (r) => { window.location.href = r.url; },
      error: (e: HttpErrorResponse) => { this.ocupado.set(false); this.fallo(e); },
    });
  }

  abrirToken(): void { this.wabaId.set(''); this.tokenWa.set(''); this.modalToken.set(true); }

  usarToken(): void {
    this.ocupado.set(true);
    this.api.tokenWhatsapp({ waba_id: this.wabaId().trim(), token: this.tokenWa().trim() }).subscribe({
      next: (r) => { this.ocupado.set(false); this.modalToken.set(false); this.tokenWa.set(''); this.abrirSesion(r.sid); },
      error: (e: HttpErrorResponse) => { this.ocupado.set(false); this.fallo(e); },
    });
  }

  private abrirSesion(sid: string): void {
    this.api.activos(sid).subscribe({
      next: (a) => { this.sid = sid; this.selPag.set([]); this.selIg.set([]); this.selNum.set([]); this.activos.set(a); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  alternar(s: WritableSignal<string[]>, id: string, on: boolean): void {
    s.update((l) => (on ? [...new Set([...l, id])] : l.filter((x) => x !== id)));
    // Si se quita una página, también se quita su Instagram
    const a = this.activos();
    if (!on && a && s === this.selPag) {
      const ig = a.paginas.find((p) => p.id === id)?.ig?.id;
      if (ig) this.selIg.update((l) => l.filter((x) => x !== ig));
    }
  }

  cerrarSel(): void { this.activos.set(null); }

  conectarSel(): void {
    const a = this.activos();
    if (!a || this.ocupado()) return;
    this.ocupado.set(true);
    const numeros = this.selNum().map((id) => ({ id, waba_id: a.numeros.find((n) => n.id === id)?.waba_id ?? '' }));
    this.api.conectarSesion(this.sid, { paginas: this.selPag(), instagram: this.selIg(), numeros }).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        this.activos.set(null);
        if (r.conectados.length) this.ok(`Conectado: ${r.conectados.join(' · ')}`);
        if (r.avisos.length) this.falla(r.avisos.join(' · '));
        this.cargar();
      },
      error: (e: HttpErrorResponse) => { this.ocupado.set(false); this.fallo(e); },
    });
  }

  probar(c: CanalCrm): void {
    this.ocupado.set(true);
    this.api.probarCanal(c.id).subscribe({
      next: (r) => { this.ocupado.set(false); this.ok(r.detalle); this.cargar(); },
      error: (e: HttpErrorResponse) => { this.ocupado.set(false); this.fallo(e); this.cargar(); },
    });
  }

  renombrar(c: CanalCrm): void {
    const n = prompt('Nuevo nombre del canal', c.nombre)?.trim();
    if (!n || n === c.nombre) return;
    this.api.renombrarCanal(c.id, n).subscribe({ next: () => { this.ok('Nombre actualizado'); this.cargar(); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  desconectar(c: CanalCrm): void {
    if (!confirm(`¿Desconectar «${c.nombre}»? Dejará de recibir y enviar mensajes. El historial se conserva.`)) return;
    this.api.desconectarCanal(c.id).subscribe({ next: () => { this.ok('Canal desconectado'); this.cargar(); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }
}