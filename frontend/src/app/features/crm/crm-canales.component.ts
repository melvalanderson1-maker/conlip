import { ChangeDetectionStrategy, Component, OnInit, WritableSignal, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';
import { ActivosMeta, CanalCrm, DiagnosticoWa, EstadoCanales, WhatsappService } from './crm-whatsapp.service';

type Plataforma = CanalCrm['tipo'];

const TILES: { id: Plataforma; nombre: string; desc: string; color: string; letra: string; boton: string }[] = [
  { id: 'whatsapp', nombre: 'WhatsApp', desc: 'Atiende por la API oficial. Puedes conectar varios números.', color: '#25d366', letra: 'W', boton: 'Conectar WhatsApp' },
  { id: 'facebook', nombre: 'Facebook Messenger', desc: 'Mensajes de tus páginas y leads de tus anuncios.', color: '#1877f2', letra: 'f', boton: 'Conectar Facebook' },
  { id: 'instagram', nombre: 'Instagram', desc: 'Mensajes directos de tus cuentas profesionales.', color: '#e1306c', letra: 'I', boton: 'Conectar Instagram' },
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
      <p class="nota intro">Pulsa «Conectar», inicia sesión en Meta, elige lo que quieres conectar y listo. Sin copiar claves.</p>
      <div class="tiles">
        @for (t of tiles; track t.id) {
          <article class="tile">
            <div class="t-cab">
              <span class="logo" [style.background]="t.color">{{ t.letra }}</span>
              <div><b>{{ t.nombre }}</b><small>{{ t.desc }}</small></div>
            </div>
            <div class="t-est">
              @if (cuenta(t.id) > 0) { <span class="tag si">{{ cuenta(t.id) }} conectado{{ cuenta(t.id) === 1 ? '' : 's' }}</span> } @else { <span class="tag">No conectado</span> }
              @if (conErrores(t.id) > 0) { <span class="tag aviso">{{ conErrores(t.id) }} con error</span> }
            </div>
            <div class="t-acc">
              <button type="button" class="btn primary" [disabled]="ocupado()" (click)="conectar(t.id)">{{ cuenta(t.id) > 0 ? 'Conectar otro' : t.boton }}</button>
              @if (cuenta(t.id) > 0) { <button type="button" class="btn" (click)="abierto.set(abierto() === t.id ? null : t.id)">{{ abierto() === t.id ? 'Ocultar' : 'Gestionar' }}</button> }
            </div>
            @if (t.id === 'whatsapp') {
              <button type="button" class="enlace" (click)="abrirToken()">¿Tienes un token permanente de usuario del sistema? Úsalo aquí</button>
            }
            @if (abierto() === t.id || (conErrores(t.id) > 0 && abierto() === null)) {
              <div class="lista">
                @for (c of delTipo(t.id); track c.id) {
                  <div class="canal">
                    <div class="c-t">
                      <b>{{ c.nombre }}</b>
                      <small>{{ c.detalle || c.ext_id }}@if (c.legado) { · viene de Conexiones }</small>
                      @if (c.estado === 'error' && c.error) { <small class="rojo">{{ c.error }}</small> }
                    </div>
                    <span class="tag" [class.si]="c.estado === 'activo'" [class.aviso]="c.estado === 'error'">{{ estadoTxt(c.estado) }}</span>
                    <div class="fila">
                      <button type="button" class="btn" [disabled]="ocupado()" (click)="probar(c)">Probar</button>
                      @if (c.tipo === 'whatsapp') { <button type="button" class="btn" [disabled]="ocupado()" (click)="diagnosticar(c)">Estado de la cuenta</button> }
                      <button type="button" class="btn" (click)="renombrar(c)">Renombrar</button>
                      @if (!c.legado) { <button type="button" class="btn peligro" (click)="desconectar(c)">Desconectar</button> }
                    </div>
                  </div>
                }
              </div>
            }
          </article>
        }
      </div>

      <details class="avanzado">
        <summary>Ajustes avanzados (solo se usan una vez)</summary>
        <div class="chips">
          <span class="tag" [class.si]="!!e.app_id">App ID: {{ e.app_id ? 'detectado' : 'falta' }}</span>
          <span class="tag" [class.si]="e.app_secret_guardado">App Secret: {{ e.app_secret_guardado ? 'guardado' : 'falta' }}</span>
        </div>
        <p class="nota">El App ID se detecta solo con los tokens que ya guardaste. Si falta, cópialo desde Meta → tu app → Configuración → Básica.</p>
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
      </details>
    } @else { <p class="nota">Cargando…</p> }

    @if (activos(); as a) {
      <div class="overlay" (click)="cerrarSel()">
        <div class="modal ancho" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab">
            <h3>{{ modo() === 'instagram' ? 'Elige tus cuentas de Instagram' : (modo() === 'whatsapp' ? 'Elige tus números de WhatsApp' : 'Elige tus páginas de Facebook') }}</h3>
            <button type="button" class="btn ico" aria-label="Cerrar" (click)="cerrarSel()"><app-icon name="x" [size]="18" /></button>
          </header>
          @for (av of a.avisos; track $index) { <p class="nota aviso-t">{{ av }}</p> }

          @if (modo() === 'facebook') {
            @for (p of a.paginas; track p.id) {
              <div class="item">
                <label class="chk">
                  <input type="checkbox" [checked]="selPag().includes(p.id) || p.conectada" [disabled]="p.conectada" (change)="alternar(selPag, p.id, $any($event.target).checked)" />
                  <span><b>{{ p.nombre }}</b> <small>{{ p.conectada ? 'ya conectada' : 'Messenger y leads de anuncios' }}</small></span>
                </label>
              </div>
            }
          }
          @if (modo() === 'instagram') {
            @for (p of a.paginas; track p.id) {
              @if (p.ig; as ig) {
                <div class="item">
                  <label class="chk">
                    <input type="checkbox" [checked]="selIg().includes(ig.id) || p.ig_conectada" [disabled]="p.ig_conectada" (change)="alternar(selIg, ig.id, $any($event.target).checked)" />
                    <span><b>{{ ig.usuario || ig.id }}</b> <small>vinculada a {{ p.nombre }}{{ p.ig_conectada ? ' · ya conectada' : '' }}</small></span>
                  </label>
                </div>
              }
            }
          }
          @if (modo() === 'whatsapp') {
            @for (n of a.numeros; track n.id) {
              <div class="item">
                <label class="chk">
                  <input type="checkbox" [checked]="selNum().includes(n.id) || n.conectada" [disabled]="n.conectada" (change)="alternar(selNum, n.id, $any($event.target).checked)" />
                  <span><b>{{ n.numero }}</b> <small>{{ n.nombre }} · cuenta {{ n.waba || n.waba_id }}{{ n.calidad ? ' · calidad ' + n.calidad : '' }}{{ n.conectada ? ' · ya conectado' : '' }}</small></span>
                </label>
              </div>
            }
          }
          @if (vacio()) {
            <p class="nota">Meta no devolvió nada para conectar. Revisa que tu usuario tenga rol en la app y que hayas aceptado los permisos sobre la página, la cuenta o el número. Si tu número nuevo no aparece, agrégalo primero en WhatsApp Manager.</p>
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

    @if (diag(); as g) {
      <div class="overlay" (click)="diag.set(null)">
        <div class="modal ancho" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab"><h3>Estado de WhatsApp: {{ g.d.numero || g.nombre }}</h3>
            <button type="button" class="btn ico" aria-label="Cerrar" (click)="diag.set(null)"><app-icon name="x" [size]="18" /></button></header>
          <dl class="filas">
            <div><dt>¿Puede enviar mensajes?</dt><dd [class.mal]="g.d.puede_enviar === 'BLOCKED'" [class.bien]="g.d.puede_enviar === 'AVAILABLE'">{{ puede(g.d.puede_enviar) }}</dd></div>
            <div><dt>Estado del número</dt><dd>{{ g.d.estado_numero || 'Sin dato' }}</dd></div>
            <div><dt>Calidad</dt><dd>{{ g.d.calidad || 'Sin dato' }}</dd></div>
            <div><dt>Modo</dt><dd>{{ g.d.modo === 'SANDBOX' ? 'Prueba (sandbox)' : (g.d.modo === 'LIVE' ? 'Producción' : (g.d.modo || 'Sin dato')) }}</dd></div>
            <div><dt>Verificación del negocio</dt><dd>{{ g.d.verificacion_negocio || 'Sin dato' }}</dd></div>
            <div><dt>Revisión de la cuenta</dt><dd>{{ g.d.revision_cuenta || 'Sin dato' }}</dd></div>
          </dl>
          @if (g.d.problemas.length) {
            <h4>Problemas que reporta Meta</h4>
            <ul class="probs">@for (p of g.d.problemas; track $index) { <li><b>{{ p.codigo }}</b> {{ p.detalle }}@if (p.solucion) { <small>Solución: {{ p.solucion }}</small> }</li> }</ul>
          }
          <h4>Qué hacer</h4>
          <ol class="acciones-l">@for (a of g.d.acciones; track $index) { <li>{{ a }}</li> }</ol>
        </div>
      </div>
    }
  `,
  styles: [ESTILOS_ADMIN, `
    .intro { margin: 0 0 14px; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; align-items: start; }
    .tile { display: flex; flex-direction: column; gap: 12px; padding: 18px; background: #fff; border: 1px solid var(--line); border-radius: 16px; }
    .t-cab { display: flex; gap: 12px; align-items: center; } .t-cab div { display: flex; flex-direction: column; gap: 2px; } .t-cab small { color: var(--muted); }
    .logo { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; color: #fff; font-size: 1.3rem; font-weight: 800; flex: none; }
    .t-est { display: flex; gap: 8px; flex-wrap: wrap; } .t-acc { display: flex; gap: 8px; flex-wrap: wrap; }
    .enlace { align-self: flex-start; padding: 0; border: 0; background: none; color: var(--brand); font: inherit; font-size: .82rem; font-weight: 600; cursor: pointer; text-align: left; }
    .tag { padding: 2px 10px; border-radius: 999px; background: #e8edf8; color: #334155; font-size: .74rem; font-weight: 600; } .tag.si { background: #dcfce7; color: #047857; } .tag.aviso { background: #fef3c7; color: #b45309; }
    .lista { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px; }
    .canal { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .c-t { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; } .c-t small { color: var(--muted); } .rojo { color: #b91c1c !important; }
    .avanzado { margin-top: 18px; padding: 14px 16px; background: #fff; border: 1px solid var(--line); border-radius: 14px; } .avanzado summary { cursor: pointer; font-weight: 600; color: var(--brand); }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; } .url { word-break: break-all; margin: 0 6px; }
    .modal.ancho { width: min(720px, 100%); max-height: 90vh; overflow-y: auto; } .m-cab { display: flex; justify-content: space-between; align-items: center; }
    .item { padding: 8px 0; border-bottom: 1px solid #f0f3fa; }
    .chk { display: flex; flex-direction: row; align-items: flex-start; gap: 10px; font-weight: 500; cursor: pointer; } .chk input { width: 18px; height: 18px; margin-top: 2px; accent-color: var(--brand); }
    .chk small { color: var(--muted); } .aviso-t { color: #b45309; }
    .filas { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px; } .filas dt { color: var(--muted); font-size: .76rem; text-transform: uppercase; letter-spacing: .05em; } .filas dd { margin: 2px 0 0; font-weight: 700; }
    .filas dd.mal { color: #b91c1c; } .filas dd.bien { color: #047857; }
    h4 { margin: 14px 0 6px; } .probs, .acciones-l { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 8px; font-size: .88rem; line-height: 1.5; } .probs small { display: block; color: var(--muted); }
  `],
})
export class CrmCanalesComponent implements OnInit {
  private readonly api: WhatsappService = inject(WhatsappService);
  readonly tiles = TILES;

  readonly est = signal<EstadoCanales | null>(null);
  readonly appId = signal<string>('');
  readonly configId = signal<string>('');
  readonly abierto = signal<Plataforma | null>(null);
  readonly activos = signal<ActivosMeta | null>(null);
  readonly selPag = signal<string[]>([]);
  readonly selIg = signal<string[]>([]);
  readonly selNum = signal<string[]>([]);
  readonly modalToken = signal<boolean>(false);
  readonly wabaId = signal<string>('');
  readonly tokenWa = signal<string>('');
  readonly diag = signal<{ nombre: string; d: DiagnosticoWa } | null>(null);
  readonly ocupado = signal<boolean>(false);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  private sid = '';

  readonly modo = computed<Plataforma>(() => {
    const t = this.activos()?.tipo;
    return t === 'instagram' ? 'instagram' : t === 'whatsapp' ? 'whatsapp' : 'facebook';
  });
  readonly vacio = computed<boolean>(() => {
    const a = this.activos();
    if (!a) return false;
    return this.modo() === 'whatsapp' ? !a.numeros.length : this.modo() === 'instagram' ? !a.paginas.some((p) => p.ig) : !a.paginas.length;
  });

  ngOnInit(): void {
    // Al volver de Meta, la dirección trae ?canales=ok&sid=...&p=... (o canales=error&msg=...)
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
    this.ocupado.set(false);
    const d = e.error?.detail;
    this.falla(typeof d === 'string' ? d : 'No se pudo conectar con el servidor');
  }

  delTipo(t: Plataforma): CanalCrm[] { return (this.est()?.canales ?? []).filter((c) => c.tipo === t); }
  cuenta(t: Plataforma): number { return this.delTipo(t).length; }
  conErrores(t: Plataforma): number { return this.delTipo(t).filter((c) => c.estado === 'error').length; }
  estadoTxt(e: string): string { return ESTADOS[e] ?? e; }
  puede(v: string): string { return ({ AVAILABLE: 'Sí', LIMITED: 'Limitado', BLOCKED: 'BLOQUEADO' } as Record<string, string>)[v] ?? (v || 'Sin dato'); }
  haySeleccion(): boolean {
    return this.modo() === 'whatsapp' ? this.selNum().length > 0 : this.modo() === 'instagram' ? this.selIg().length > 0 : this.selPag().length > 0;
  }

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

  // ---------------- Conectar con un clic ----------------
  conectar(p: Plataforma): void {
    this.ocupado.set(true);
    this.api.iniciarOauth(p).subscribe({
      next: (r) => { window.location.href = r.url; },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  abrirToken(): void { this.wabaId.set(''); this.tokenWa.set(''); this.modalToken.set(true); }

  usarToken(): void {
    this.ocupado.set(true);
    this.api.tokenWhatsapp({ waba_id: this.wabaId().trim(), token: this.tokenWa().trim() }).subscribe({
      next: (r) => { this.ocupado.set(false); this.modalToken.set(false); this.tokenWa.set(''); this.abrirSesion(r.sid); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  private abrirSesion(sid: string): void {
    this.api.activos(sid).subscribe({
      next: (a) => {
        this.sid = sid;
        // Todo lo que todavía no está conectado viene marcado: normalmente solo hay que pulsar «Conectar seleccionados»
        this.selPag.set(a.tipo === 'instagram' || a.tipo === 'whatsapp' ? [] : a.paginas.filter((p) => !p.conectada).map((p) => p.id));
        this.selIg.set(a.tipo === 'instagram' ? a.paginas.flatMap((p) => (p.ig && !p.ig_conectada ? [p.ig.id] : [])) : []);
        this.selNum.set(a.tipo === 'whatsapp' ? a.numeros.filter((n) => !n.conectada).map((n) => n.id) : []);
        this.activos.set(a);
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  alternar(s: WritableSignal<string[]>, id: string, on: boolean): void {
    s.update((l) => (on ? [...new Set([...l, id])] : l.filter((x) => x !== id)));
  }

  cerrarSel(): void { this.activos.set(null); }

  conectarSel(): void {
    const a = this.activos();
    if (!a || this.ocupado()) return;
    this.ocupado.set(true);
    const instagram = this.selIg();
    const paginas = this.modo() === 'instagram' ? a.paginas.filter((p) => p.ig && instagram.includes(p.ig.id)).map((p) => p.id) : this.selPag();
    const numeros = this.selNum().map((id) => ({ id, waba_id: a.numeros.find((n) => n.id === id)?.waba_id ?? '' }));
    this.api.conectarSesion(this.sid, { paginas, instagram, numeros, con_messenger: this.modo() !== 'instagram' }).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        this.activos.set(null);
        if (r.conectados.length) this.ok(`Conectado: ${r.conectados.join(' · ')}`);
        if (r.avisos.length) this.falla(r.avisos.join(' · '));
        this.cargar();
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  // ---------------- Gestión ----------------
  probar(c: CanalCrm): void {
    this.ocupado.set(true);
    this.api.probarCanal(c.id).subscribe({
      next: (r) => { this.ocupado.set(false); this.ok(r.detalle); this.cargar(); },
      error: (e: HttpErrorResponse) => { this.fallo(e); this.cargar(); },
    });
  }

  diagnosticar(c: CanalCrm): void {
    this.ocupado.set(true);
    this.api.diagnosticoCanal(c.id).subscribe({
      next: (d) => { this.ocupado.set(false); this.diag.set({ nombre: c.nombre, d }); this.cargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
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