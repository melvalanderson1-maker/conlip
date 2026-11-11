import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';
import { EstadoWa, WhatsappService } from './crm-whatsapp.service';

@Component({
  selector: 'app-crm-conexiones',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mensaje()) { <p class="ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
    @if (error()) { <p class="error"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

    @if (est(); as e) {
      <section class="card">
        <div class="fila">
          <div class="grande">
            <h3>WhatsApp Business (Meta)</h3>
            <p class="nota">Recibe y responde los mensajes de tus clientes dentro del CRM. Usa la API oficial de Meta.</p>
          </div>
          <span class="estado" [class.ok]="e.configurado">{{ e.configurado ? 'Configurado' : 'Sin configurar' }}</span>
        </div>
        @if (!e.clave_ok) {
          <p class="error"><app-icon name="alert" [size]="18" /> Falta SECRETS_KEY en el servidor: no se pueden guardar credenciales hasta configurarla.</p>
        }
        @if (e.ultimo_evento) { <p class="nota">Último aviso recibido de Meta: {{ hace(e.ultimo_evento) }}</p> }

        <div class="grid2">
          <label>Phone number ID <input inputmode="numeric" [value]="phone()" (input)="phone.set($any($event.target).value)" [placeholder]="e.phone_id || 'Solo números'" /></label>
          <label>ID de la cuenta de WhatsApp Business (WABA) <input inputmode="numeric" [value]="waba()" (input)="waba.set($any($event.target).value)" [placeholder]="e.waba_id || 'Solo números'" /></label>
          <label>Token de acceso (usuario del sistema)
            <input type="password" autocomplete="new-password" [value]="token()" (input)="token.set($any($event.target).value)" [placeholder]="e.token_guardado ? 'Guardado. Escribe solo para cambiarlo' : 'Pega el token'" />
          </label>
          <label>App Secret
            <input type="password" autocomplete="new-password" [value]="secreto()" (input)="secreto.set($any($event.target).value)" [placeholder]="e.secreto_guardado ? 'Guardado. Escribe solo para cambiarlo' : 'Pega el App Secret'" />
          </label>
          <label>Versión de la API <input [value]="version()" (input)="version.set($any($event.target).value)" [placeholder]="e.version" /></label>
        </div>

        <div class="web">
          <b>Dirección del webhook (se pega en Meta)</b>
          <div class="copia"><code>{{ e.webhook_url }}</code><button type="button" class="btn" (click)="copiar(e.webhook_url)">Copiar</button></div>
          <b>Token de verificación (se pega en Meta)</b>
          @if (e.verify_token) {
            <div class="copia"><code>{{ e.verify_token }}</code><button type="button" class="btn" (click)="copiar(e.verify_token)">Copiar</button></div>
          } @else { <small class="nota">Se genera al guardar por primera vez.</small> }
        </div>

        <div class="fila acciones">
          <button type="button" class="btn" [disabled]="ocupado() || !e.configurado" (click)="probar()">Probar conexión</button>
          <button type="button" class="btn" [disabled]="ocupado() || !e.configurado || !e.waba_id" (click)="suscribir()">Suscribir mi app</button>
          <button type="button" class="btn primary" [disabled]="ocupado()" (click)="guardar()">Guardar</button>
        </div>

        <details class="pasos">
          <summary>Cómo conectarlo paso a paso</summary>
          <ol>
            <li>En <b>developers.facebook.com</b> crea una app de tipo <b>Business</b> y agrégale el producto <b>WhatsApp</b>.</li>
            <li>En el panel de WhatsApp de la app crea o conecta tu cuenta de WhatsApp Business y <b>agrega el número</b>. Copia aquí el <b>Phone number ID</b> y el <b>ID de la cuenta de WhatsApp Business</b>.</li>
            <li>En <b>Business Settings → Usuarios del sistema</b> crea un usuario administrador, asígnale la app y la cuenta de WhatsApp, y genera un <b>token sin vencimiento</b> con los permisos <i>whatsapp_business_messaging</i> y <i>whatsapp_business_management</i>. Pégalo aquí.</li>
            <li>En la app, <b>Configuración → Básica</b>, copia el <b>App Secret</b> y pégalo aquí.</li>
            <li>Pulsa <b>Guardar</b> y luego <b>Probar conexión</b>.</li>
            <li>En Meta, en la configuración de WhatsApp de tu app, pega la <b>dirección del webhook</b> y el <b>token de verificación</b> de arriba, y suscríbete al campo <b>messages</b>. Después pulsa aquí <b>Suscribir mi app</b>.</li>
            <li>Pasa la app a modo <b>Live</b> (Meta pide la URL de tu política de privacidad: usa la de tu sitio) y completa la <b>verificación del negocio</b> para poder escribirle a clientes reales.</li>
            <li>Las <b>plantillas</b> de mensaje se crean y aprueban en el Administrador de WhatsApp de Meta.</li>
          </ol>
        </details>
        <p class="nota">Importante: usa un número <b>dedicado a la API</b> y que sea el mismo que muestras al público (el del botón de WhatsApp). Un número registrado en la API normalmente deja de funcionar en la app de WhatsApp del celular.</p>
      </section>

      <section class="card off">
        <h3>Facebook e Instagram</h3>
        <p class="nota">Leads de anuncios de Facebook, Messenger e Instagram: llegan en la siguiente fase.</p>
      </section>
    }
  `,
  styles: [ESTILOS_ADMIN, `
    .web { display: flex; flex-direction: column; gap: 6px; margin: 14px 0; padding: 12px 14px; background: #f8faff; border: 1px dashed #b5c2e0; border-radius: 12px; }
    .copia { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .copia code { flex: 1; min-width: 220px; padding: 8px 10px; border-radius: 8px; background: #fff; border: 1px solid var(--line); word-break: break-all; font-size: .84rem; user-select: all; }
    .pasos { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; } .pasos summary { cursor: pointer; font-weight: 600; color: var(--brand); }
    .pasos ol { margin: 10px 0 0; padding-left: 22px; display: flex; flex-direction: column; gap: 8px; color: #334155; font-size: .88rem; line-height: 1.5; }
    .card.off { opacity: .65; }
  `],
})
export class CrmConexionesComponent implements OnInit {
  private readonly api: WhatsappService = inject(WhatsappService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);

  readonly est = signal<EstadoWa | null>(null);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly ocupado = signal<boolean>(false);
  readonly phone = signal<string>('');
  readonly waba = signal<string>('');
  readonly token = signal<string>('');
  readonly secreto = signal<string>('');
  readonly version = signal<string>('');

  ngOnInit(): void {
    this.cargar();
    // Cada mensaje o estado que llega de Meta refresca "Último aviso recibido"
    this.rt.cambios('crm').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargar());
  }

  private cargar(): void {
    this.api.estado().subscribe({ next: (e) => this.est.set(e), error: (er: HttpErrorResponse) => this.fallo(er) });
  }

  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private fallo(e: HttpErrorResponse): void {
    this.mensaje.set(''); this.ocupado.set(false);
    const d = e.error?.detail;
    this.error.set(typeof d === 'string' ? d : 'No se pudo conectar con el servidor');
  }

  hace(iso: string): string {
    const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    if (min < 1440) return `hace ${Math.floor(min / 60)} h`;
    return `hace ${Math.floor(min / 1440)} días`;
  }

  async copiar(texto: string): Promise<void> {
    try { await navigator.clipboard.writeText(texto); this.ok('Copiado'); } catch { this.mensaje.set(''); this.error.set('No se pudo copiar. Selecciona el texto y cópialo a mano.'); }
  }

  guardar(): void {
    this.ocupado.set(true);
    this.api.guardar({ phone_id: this.phone(), waba_id: this.waba(), token: this.token(), app_secret: this.secreto(), version: this.version() }).subscribe({
      next: () => {
        this.ocupado.set(false); this.phone.set(''); this.waba.set(''); this.token.set(''); this.secreto.set(''); this.version.set('');
        this.ok('Guardado. Ahora pulsa «Probar conexión».'); this.cargar();
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  probar(): void {
    this.ocupado.set(true);
    this.api.probar().subscribe({ next: (r) => { this.ocupado.set(false); this.ok(r.detalle); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  suscribir(): void {
    this.ocupado.set(true);
    this.api.suscribir().subscribe({ next: (r) => { this.ocupado.set(false); this.ok(r.detalle); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }
}