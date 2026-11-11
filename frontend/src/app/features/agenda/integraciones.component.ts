import { ChangeDetectionStrategy, Component, Injectable, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';

export interface EstadoInteg {
  clave_ok: boolean;
  zoom: { configurado: boolean; account_id: string; client_id: string; host: string };
  google: { configurado: boolean; conectado: boolean; client_id: string; email: string; redirect_uri: string };
}
interface Resultado { ok: boolean; detalle: string; }

@Injectable({ providedIn: 'root' })
export class IntegracionesService {
  private readonly http: HttpClient = inject(HttpClient);
  private readonly base = `${API}/integraciones`;

  estado(): Observable<EstadoInteg> { return this.http.get<EstadoInteg>(this.base); }
  guardarZoom(d: { account_id: string; client_id: string; client_secret: string; host: string }): Observable<unknown> {
    return this.http.put(`${this.base}/zoom`, d);
  }
  probarZoom(): Observable<Resultado> { return this.http.post<Resultado>(`${this.base}/zoom/probar`, {}); }
  guardarGoogle(d: { client_id: string; client_secret: string }): Observable<unknown> { return this.http.put(`${this.base}/google`, d); }
  autorizarGoogle(): Observable<{ url: string }> { return this.http.get<{ url: string }>(`${this.base}/google/autorizar`); }
  probarGoogle(): Observable<Resultado> { return this.http.post<Resultado>(`${this.base}/google/probar`, {}); }
  desconectarGoogle(): Observable<unknown> { return this.http.delete(`${this.base}/google`); }
}

@Component({
  selector: 'app-integraciones',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mensaje()) { <p class="ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
    @if (error()) { <p class="error"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

    @if (est(); as e) {
      @if (!e.clave_ok) {
        <p class="error"><app-icon name="alert" [size]="18" />
          Falta la variable SECRETS_KEY en backend/.env. Sin ella no se pueden guardar credenciales. Agrégala y reinicia el servidor.</p>
      }
      <p class="nota">Aquí conectas Zoom y Google Meet una sola vez. Después, en la pestaña Asesores, eliges para cada asesor si usa el enlace fijo
        de su sala o si el sistema crea un enlace nuevo por cada sesión. Si algo falla al crear la sala, la cita no se pierde: se usa el enlace fijo del asesor.</p>

      <!-- ================= ZOOM ================= -->
      <section class="card">
        <div class="i-cab">
          <span class="logo zoom"><app-icon name="video" [size]="22" /></span>
          <div><h3>Zoom</h3><small>Crea, mueve y elimina una reunión por cada sesión</small></div>
          <span class="estado" [class.ok]="e.zoom.configurado">{{ e.zoom.configurado ? 'Configurado' : 'Sin configurar' }}</span>
        </div>
        <div class="grid2">
          <label>Account ID
            <input autocomplete="off" [value]="zAccount()" (input)="zAccount.set($any($event.target).value)" [placeholder]="e.zoom.account_id || 'Pega tu Account ID'" />
          </label>
          <label>Client ID
            <input autocomplete="off" [value]="zClient()" (input)="zClient.set($any($event.target).value)" [placeholder]="e.zoom.client_id || 'Pega tu Client ID'" />
          </label>
          <label>Client Secret
            <input type="password" autocomplete="new-password" [value]="zSecret()" (input)="zSecret.set($any($event.target).value)"
                   [placeholder]="e.zoom.configurado ? 'Guardado. Escribe solo si quieres cambiarlo' : 'Pega tu Client Secret'" />
          </label>
          <label>Cuenta anfitriona (correo de la cuenta de Zoom)
            <input type="email" [value]="zHost()" (input)="zHost.set($any($event.target).value)" placeholder="asesoria@tuempresa.com" />
          </label>
        </div>
        <div class="fila acciones">
          <button type="button" class="btn" [disabled]="!e.zoom.configurado || ocupado()" (click)="probarZoom()">Probar conexión</button>
          <button type="button" class="btn primary" [disabled]="ocupado()" (click)="guardarZoom()">Guardar</button>
        </div>
        <details class="pasos">
          <summary>Cómo obtener estas credenciales</summary>
          <ol>
            <li>Entra a <b>marketplace.zoom.us</b> con la cuenta de Zoom que será la anfitriona y ve a <b>Develop → Build App</b>.</li>
            <li>Elige <b>Server-to-Server OAuth App</b> y ponle un nombre.</li>
            <li>Copia el <b>Account ID</b>, el <b>Client ID</b> y el <b>Client Secret</b> y pégalos arriba.</li>
            <li>En <b>Scopes</b> agrega los permisos de reuniones (crear, actualizar y eliminar) y el de leer usuarios. Zoom los muestra con nombres como <i>meeting:write:admin</i> o sus equivalentes más detallados.</li>
            <li>Completa los datos básicos que pide y <b>activa la app</b>.</li>
            <li>Escribe arriba el correo de esa cuenta en <b>Cuenta anfitriona</b>, pulsa <b>Guardar</b> y luego <b>Probar conexión</b>.</li>
          </ol>
        </details>
      </section>

      <!-- ================= GOOGLE MEET ================= -->
      <section class="card">
        <div class="i-cab">
          <span class="logo meet"><app-icon name="video" [size]="22" /></span>
          <div><h3>Google Meet (Calendar)</h3><small>Crea un evento con enlace de Meet e invita al asesor y al cliente</small></div>
          <span class="estado" [class.ok]="e.google.conectado">
            {{ e.google.conectado ? 'Conectado' : (e.google.configurado ? 'Falta conectar la cuenta' : 'Sin configurar') }}
          </span>
        </div>
        @if (e.google.conectado && e.google.email) { <p class="cuenta"><app-icon name="mail" [size]="15" /> Cuenta conectada: <b>{{ e.google.email }}</b></p> }
        <div class="grid2">
          <label>Client ID
            <input autocomplete="off" [value]="gClient()" (input)="gClient.set($any($event.target).value)" [placeholder]="e.google.client_id || 'Pega tu Client ID'" />
          </label>
          <label>Client Secret
            <input type="password" autocomplete="new-password" [value]="gSecret()" (input)="gSecret.set($any($event.target).value)"
                   [placeholder]="e.google.configurado ? 'Guardado. Escribe solo si quieres cambiarlo' : 'Pega tu Client Secret'" />
          </label>
        </div>
        <div class="uri">
          <small>URI de redireccionamiento que debes registrar en Google (cópiala exacta):</small>
          <code>{{ e.google.redirect_uri }}</code>
        </div>
        <div class="fila acciones">
          @if (e.google.conectado) {
            <button type="button" class="btn peligro" [disabled]="ocupado()" (click)="desconectarGoogle()">Desconectar cuenta</button>
            <button type="button" class="btn" [disabled]="ocupado()" (click)="probarGoogle()">Probar conexión</button>
          }
          <button type="button" class="btn" [disabled]="ocupado()" (click)="guardarGoogle()">Guardar credenciales</button>
          <button type="button" class="btn primary" [disabled]="!e.google.configurado || ocupado()" (click)="conectarGoogle()">
            {{ e.google.conectado ? 'Reconectar con Google' : 'Conectar con Google' }}
          </button>
        </div>
        <details class="pasos">
          <summary>Cómo obtener estas credenciales</summary>
          <ol>
            <li>Entra a <b>console.cloud.google.com</b> y crea un proyecto.</li>
            <li>En <b>APIs y servicios → Biblioteca</b> busca y activa <b>Google Calendar API</b>.</li>
            <li>En <b>Pantalla de consentimiento de OAuth</b> elige tipo <b>Externo</b>, agrega como usuario de prueba el correo de la cuenta que será dueña de las reuniones y el permiso <i>.../auth/calendar.events</i>. Al terminar pulsa <b>Publicar aplicación</b>: si la dejas en modo prueba, el permiso vence a los 7 días.</li>
            <li>En <b>Credenciales → Crear credenciales → ID de cliente de OAuth</b> elige <b>Aplicación web</b> y, en <b>URI de redireccionamiento autorizados</b>, pega la URI de arriba.</li>
            <li>Copia el <b>Client ID</b> y el <b>Client Secret</b> aquí y pulsa <b>Guardar credenciales</b>.</li>
            <li>Pulsa <b>Conectar con Google</b>, entra con la cuenta dueña de las reuniones y acepta los permisos. Si Google dice que la app no está verificada, elige <b>Avanzado → continuar</b>.</li>
            <li>Vuelves aquí y pulsas <b>Probar conexión</b>.</li>
          </ol>
        </details>
      </section>
    }
  `,
  styles: [ESTILOS_ADMIN, `
    .i-cab { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; } .i-cab > div { flex: 1; } .i-cab h3 { margin: 0; } .i-cab small { color: var(--muted); }
    .logo { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; color: #fff; flex: none; } .logo.zoom { background: #2d8cff; } .logo.meet { background: #00897b; }
    .cuenta { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; color: #334155; font-size: .9rem; }
    .uri { display: flex; flex-direction: column; gap: 6px; margin: 14px 0; padding: 12px 14px; background: #f8faff; border: 1px dashed #b5c2e0; border-radius: 12px; } .uri small { color: var(--muted); }
    .uri code { word-break: break-all; font-size: .84rem; color: #0f172a; user-select: all; }
    .pasos { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; } .pasos summary { cursor: pointer; font-weight: 600; color: var(--brand); }
    .pasos ol { margin: 10px 0 0; padding-left: 22px; display: flex; flex-direction: column; gap: 8px; color: #334155; font-size: .88rem; line-height: 1.5; }
  `],
})
export class IntegracionesComponent implements OnInit {
  private readonly api: IntegracionesService = inject(IntegracionesService);

  readonly est = signal<EstadoInteg | null>(null);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly ocupado = signal<boolean>(false);

  readonly zAccount = signal<string>('');
  readonly zClient = signal<string>('');
  readonly zSecret = signal<string>('');
  readonly zHost = signal<string>('');
  readonly gClient = signal<string>('');
  readonly gSecret = signal<string>('');

  ngOnInit(): void {
    // Al volver de Google, el servidor nos redirige con ?google=ok o ?google=error
    const q = new URLSearchParams(location.search);
    const g = q.get('google');
    if (g === 'ok') this.mensaje.set('Cuenta de Google conectada correctamente. Pulsa "Probar conexión" para confirmar.');
    if (g === 'error') this.error.set(q.get('msg') || 'No se pudo conectar con Google');
    if (g) history.replaceState(null, '', location.pathname);
    this.cargar();
  }

  private cargar(): void {
    this.api.estado().subscribe({
      next: (e) => { this.est.set(e); if (!this.zHost()) this.zHost.set(e.zoom.host); },
      error: (er: HttpErrorResponse) => this.fallo(er),
    });
  }

  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private fallo(e: HttpErrorResponse): void { this.mensaje.set(''); this.error.set(this.msg(e)); }

  guardarZoom(): void {
    this.ocupado.set(true);
    this.api.guardarZoom({ account_id: this.zAccount(), client_id: this.zClient(), client_secret: this.zSecret(), host: this.zHost() }).subscribe({
      next: () => {
        this.ocupado.set(false); this.zAccount.set(''); this.zClient.set(''); this.zSecret.set('');
        this.ok('Credenciales de Zoom guardadas. Pulsa "Probar conexión".'); this.cargar();
      },
      error: (e: HttpErrorResponse) => { this.ocupado.set(false); this.fallo(e); },
    });
  }

  probarZoom(): void {
    this.ocupado.set(true);
    this.api.probarZoom().subscribe({
      next: (r) => { this.ocupado.set(false); this.ok(r.detalle); },
      error: (e: HttpErrorResponse) => { this.ocupado.set(false); this.fallo(e); },
    });
  }

  guardarGoogle(): void {
    this.ocupado.set(true);
    this.api.guardarGoogle({ client_id: this.gClient(), client_secret: this.gSecret() }).subscribe({
      next: () => {
        this.ocupado.set(false); this.gClient.set(''); this.gSecret.set('');
        this.ok('Credenciales de Google guardadas. Ahora pulsa "Conectar con Google".'); this.cargar();
      },
      error: (e: HttpErrorResponse) => { this.ocupado.set(false); this.fallo(e); },
    });
  }

  conectarGoogle(): void {
    this.ocupado.set(true);
    this.api.autorizarGoogle().subscribe({
      next: (r) => { location.href = r.url; },
      error: (e: HttpErrorResponse) => { this.ocupado.set(false); this.fallo(e); },
    });
  }

  probarGoogle(): void {
    this.ocupado.set(true);
    this.api.probarGoogle().subscribe({
      next: (r) => { this.ocupado.set(false); this.ok(r.detalle); },
      error: (e: HttpErrorResponse) => { this.ocupado.set(false); this.fallo(e); },
    });
  }

  desconectarGoogle(): void {
    if (!confirm('¿Desconectar la cuenta de Google? Las próximas sesiones con Meet automático usarán el enlace fijo del asesor.')) return;
    this.api.desconectarGoogle().subscribe({
      next: () => { this.ok('Cuenta de Google desconectada.'); this.cargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    return typeof d === 'string' ? d : 'No se pudo conectar con el servidor';
  }
}