import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';
import { EstadoMeta, EstadoWa, WhatsappService } from './crm-whatsapp.service';

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
    }

    @if (estM(); as m) {
      <section class="card">
        <div class="fila">
          <div class="grande">
            <h3>Facebook e Instagram (Meta)</h3>
            <p class="nota">Leads de anuncios de Facebook (formularios instantáneos), mensajes de Messenger y mensajes directos de Instagram, en la misma ficha del lead. Usa la misma app de Meta que WhatsApp.</p>
          </div>
          <span class="estado" [class.ok]="m.configurado">{{ m.configurado ? 'Configurado' : 'Sin configurar' }}</span>
        </div>
        @if (!m.secreto_guardado) {
          <p class="error"><app-icon name="alert" [size]="18" /> Falta el App Secret de la app. Guárdalo en la tarjeta de WhatsApp de arriba: es el mismo y sirve para validar que los avisos vienen de Meta.</p>
        }
        @if (m.ultimo_evento) { <p class="nota">Último aviso recibido de Facebook o Instagram: {{ hace(m.ultimo_evento) }}</p> }

        <div class="grid2">
          <label>ID de la página de Facebook <input inputmode="numeric" [value]="pageId()" (input)="pageId.set($any($event.target).value)" [placeholder]="m.page_id || 'Solo números'" /></label>
          <label>ID de la cuenta de Instagram (opcional) <input inputmode="numeric" [value]="igId()" (input)="igId.set($any($event.target).value)" [placeholder]="m.ig_id || 'Solo números'" /></label>
          <label>Token de acceso de la página (Messenger)
            <input type="password" autocomplete="new-password" [value]="tokenM()" (input)="tokenM.set($any($event.target).value)" [placeholder]="m.token_guardado ? 'Guardado. Escribe solo para cambiarlo' : 'Pega el token de la página'" />
          </label>
          <label>Token de Instagram
            <input type="password" autocomplete="new-password" [value]="tokenIg()" (input)="tokenIg.set($any($event.target).value)" [placeholder]="m.ig_token_guardado ? 'Guardado. Escribe solo para cambiarlo' : 'Pega el token de Instagram'" />
          </label>
        </div>

        <div class="web">
          <b>Dirección del webhook (se pega en Meta, para Page e Instagram)</b>
          <div class="copia"><code>{{ m.webhook_url }}</code><button type="button" class="btn" (click)="copiar(m.webhook_url)">Copiar</button></div>
          <b>Token de verificación (el mismo de WhatsApp)</b>
          @if (m.verify_token) {
            <div class="copia"><code>{{ m.verify_token }}</code><button type="button" class="btn" (click)="copiar(m.verify_token)">Copiar</button></div>
          } @else { <small class="nota">Se genera al guardar por primera vez.</small> }
        </div>

        <div class="fila acciones">
          <button type="button" class="btn" [disabled]="ocupado() || !m.configurado" (click)="probarMeta()">Probar conexión</button>
          <button type="button" class="btn" [disabled]="ocupado() || !m.configurado" (click)="suscribirMeta()">Suscribir mi página</button>
          <button type="button" class="btn primary" [disabled]="ocupado()" (click)="guardarMeta()">Guardar</button>
        </div>

        <details class="pasos">
          <summary>Cómo conectarlo paso a paso</summary>
          <ol>
            <li>Usa la <b>misma app</b> de Meta de WhatsApp. En <b>Agregar productos</b> añade <b>Messenger</b> y, si quieres Instagram, <b>Instagram</b>.</li>
            <li>Tu página de Facebook debe estar en el mismo portafolio comercial. Para Instagram, la cuenta debe ser <b>profesional</b> y estar <b>vinculada a esa página</b>. En la app de Instagram, en Configuración → Mensajes y respuestas a historias, activa el acceso a mensajes para herramientas conectadas.</li>
            <li>Necesitas un <b>token de página de larga duración</b> con los permisos <i>pages_messaging</i>, <i>pages_show_list</i>, <i>pages_manage_metadata</i>, <i>pages_read_engagement</i> y <i>leads_retrieval</i>; para Instagram, también <i>instagram_basic</i> e <i>instagram_manage_messages</i>. Una forma: en el Explorador de la API Graph genera un token de usuario con esos permisos, cámbialo por uno de larga duración y consulta <i>me/accounts</i>: el token que aparece junto a tu página es el que debes pegar aquí.</li>
            <li>El <b>ID de la página</b> está en Información de la página de Facebook. El <b>ID de Instagram</b> se obtiene con el campo <i>instagram_business_account</i> de la página en el Explorador de la API Graph.</li>
            <li>Pulsa <b>Guardar</b> y luego <b>Probar conexión</b>: debe mostrar el nombre de tu página (y tu usuario de Instagram si lo pusiste).</li>
            <li>En Meta, en <b>Webhooks</b> de tu app, elige el objeto <b>Page</b>, pega la <b>dirección del webhook</b> y el <b>token de verificación</b> de arriba y suscríbete a los campos <b>messages</b> y <b>leadgen</b>. Repite para el objeto <b>Instagram</b> con el campo <b>messages</b>. Después pulsa aquí <b>Suscribir mi página</b>.</li>
            <li>Mientras la app esté en modo de desarrollo, solo se reciben mensajes y leads de personas con un rol en la app. Para el público real, Meta exige <b>revisión de la app</b> (acceso avanzado) de estos permisos y la verificación del negocio.</li>
          </ol>
        </details>
        <p class="nota">Facebook e Instagram solo permiten responder durante las <b>24 horas</b> siguientes al último mensaje del cliente. Por ahora se reciben y muestran imágenes, audios y archivos, pero desde el CRM solo se envía texto.</p>
      </section>

      <section class="card">
        <div class="fila">
          <div class="grande">
            <h3>Entrada por webhook (Zapier, Make, tu landing)</h3>
            <p class="nota">Cualquier herramienta puede crear leads en el CRM enviando un JSON a esta dirección con la clave en la cabecera <b>X-Webhook-Key</b>. Úsala solo desde un servidor o desde Zapier o Make: si la pones en una página web, cualquiera podría verla y copiarla.</p>
          </div>
          <span class="estado" [class.ok]="m.clave_entrada_guardada">{{ m.clave_entrada_guardada ? 'Con clave' : 'Sin clave' }}</span>
        </div>
        <div class="web">
          <b>Dirección</b>
          <div class="copia"><code>{{ m.entrada_url }}</code><button type="button" class="btn" (click)="copiar(m.entrada_url)">Copiar</button></div>
          @if (claveNueva(); as k) {
            <b>Tu clave nueva (cópiala ahora: no se vuelve a mostrar)</b>
            <div class="copia"><code>{{ k }}</code><button type="button" class="btn" (click)="copiar(k)">Copiar</button></div>
          }
          <b>Ejemplo</b>
          <pre>{{ ejemplo(m.entrada_url) }}</pre>
          <small class="nota">Campos: nombre (obligatorio), telefono o correo (al menos uno), empresa, interes, valor y origen (una palabra en minúsculas, por ejemplo web). Si ya existe un lead abierto con ese teléfono o correo, se le suma una actividad en vez de duplicarlo.</small>
        </div>
        <div class="fila acciones">
          <button type="button" class="btn primary" [disabled]="ocupado() || !m.clave_ok" (click)="generarClave()">{{ m.clave_entrada_guardada ? 'Generar una clave nueva' : 'Generar clave' }}</button>
        </div>
      </section>
    }
  `,
  styles: [ESTILOS_ADMIN, `
    .web { display: flex; flex-direction: column; gap: 6px; margin: 14px 0; padding: 12px 14px; background: #f8faff; border: 1px dashed #b5c2e0; border-radius: 12px; }
    .copia { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .copia code { flex: 1; min-width: 220px; padding: 8px 10px; border-radius: 8px; background: #fff; border: 1px solid var(--line); word-break: break-all; font-size: .84rem; user-select: all; }
    .web pre { margin: 0; padding: 10px 12px; border-radius: 8px; background: #0f172a; color: #e2e8f0; font-size: .78rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
    .pasos { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; } .pasos summary { cursor: pointer; font-weight: 600; color: var(--brand); }
    .pasos ol { margin: 10px 0 0; padding-left: 22px; display: flex; flex-direction: column; gap: 8px; color: #334155; font-size: .88rem; line-height: 1.5; }
  `],
})
export class CrmConexionesComponent implements OnInit {
  private readonly api: WhatsappService = inject(WhatsappService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);

  readonly est = signal<EstadoWa | null>(null);
  readonly estM = signal<EstadoMeta | null>(null);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly ocupado = signal<boolean>(false);
  readonly phone = signal<string>('');
  readonly waba = signal<string>('');
  readonly token = signal<string>('');
  readonly secreto = signal<string>('');
  readonly version = signal<string>('');
  readonly pageId = signal<string>('');
  readonly igId = signal<string>('');
  readonly tokenM = signal<string>('');
  readonly tokenIg = signal<string>('');
  readonly claveNueva = signal<string>('');

  ngOnInit(): void {
    this.cargar();
    // Cada mensaje o estado que llega de Meta refresca "Último aviso recibido"
    this.rt.cambios('crm').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargar());
  }

  private cargar(): void {
    this.api.estado().subscribe({ next: (e) => this.est.set(e), error: (er: HttpErrorResponse) => this.fallo(er) });
    this.api.estadoMeta().subscribe({ next: (e) => this.estM.set(e), error: (er: HttpErrorResponse) => this.fallo(er) });
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

  ejemplo(url: string): string {
    return `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "X-Webhook-Key: TU_CLAVE" \\\n  -d '{"nombre":"Ana Torres","telefono":"999888777","correo":"ana@correo.com","interes":"Plan Coti Menor","origen":"web"}'`;
  }

  async copiar(texto: string): Promise<void> {
    try { await navigator.clipboard.writeText(texto); this.ok('Copiado'); } catch { this.mensaje.set(''); this.error.set('No se pudo copiar. Selecciona el texto y cópialo a mano.'); }
  }

  // ---------------- WhatsApp ----------------
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

  // ---------------- Facebook / Instagram ----------------
  guardarMeta(): void {
    this.ocupado.set(true);
    this.api.guardarMeta({ page_id: this.pageId(), ig_id: this.igId(), token: this.tokenM(), ig_token: this.tokenIg() }).subscribe({
      next: () => {
        this.ocupado.set(false); this.pageId.set(''); this.igId.set(''); this.tokenM.set(''); this.tokenIg.set('');
        this.ok('Guardado. Ahora pulsa «Probar conexión».'); this.cargar();
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  probarMeta(): void {
    this.ocupado.set(true);
    this.api.probarMeta().subscribe({ next: (r) => { this.ocupado.set(false); this.ok(r.detalle); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  suscribirMeta(): void {
    this.ocupado.set(true);
    this.api.suscribirMeta().subscribe({ next: (r) => { this.ocupado.set(false); this.ok(r.detalle); }, error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  generarClave(): void {
    if (this.estM()?.clave_entrada_guardada && !confirm('Ya existe una clave. Si generas otra, la anterior dejará de funcionar y tendrás que actualizarla en Zapier, Make o donde la uses. ¿Continuar?')) return;
    this.ocupado.set(true);
    this.api.nuevaClaveEntrada().subscribe({
      next: (r) => { this.ocupado.set(false); this.claveNueva.set(r.clave); this.ok('Clave generada. Cópiala ahora.'); this.cargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }
}