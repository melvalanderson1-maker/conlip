import { ChangeDetectionStrategy, Component, Injectable, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { AuthService } from '../../core/auth.service';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';

interface Estado2fa { activo: boolean; respaldo_restantes: number; exigido: boolean; }
interface Preparado { secreto: string; qr: string; }
type Modo = 'ninguno' | 'clave' | 'qr' | 'codigos' | 'desactivar' | 'regenerar';

@Injectable({ providedIn: 'root' })
export class DosPasosService {
  private readonly http: HttpClient = inject(HttpClient);
  private readonly base = `${API}/auth/2fa`;
  estado(): Observable<Estado2fa> { return this.http.get<Estado2fa>(`${this.base}/estado`); }
  preparar(clave: string): Observable<Preparado> { return this.http.post<Preparado>(`${this.base}/preparar`, { clave }); }
  activar(codigo: string): Observable<{ codigos: string[] }> { return this.http.post<{ codigos: string[] }>(`${this.base}/activar`, { codigo }); }
  desactivar(clave: string, codigo: string): Observable<unknown> { return this.http.post(`${this.base}/desactivar`, { clave, codigo }); }
  respaldo(clave: string, codigo: string): Observable<{ codigos: string[] }> {
    return this.http.post<{ codigos: string[] }>(`${this.base}/respaldo`, { clave, codigo });
  }
}

@Component({
  selector: 'app-seguridad',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <header class="cab">
        <div>
          <span class="eyebrow">Cuenta</span>
          <h2>Seguridad</h2>
          <p class="sub">Protege tu acceso con un código que solo tu teléfono puede generar.</p>
        </div>
      </header>

      @if (debe()) {
        <p class="error"><app-icon name="alert" [size]="18" /> Tu rol exige la verificación en dos pasos. Actívala para seguir usando la plataforma.</p>
      }
      @if (mensaje()) { <p class="ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
      @if (error()) { <p class="error"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

      @if (estado(); as e) {
        <section class="card">
          <div class="fila">
            <div class="grande">
              <h3>Verificación en dos pasos</h3>
              <p class="nota">Además de tu clave, se pide un código de 6 dígitos de tu app (Google Authenticator, Microsoft Authenticator, Authy…).</p>
            </div>
            <span class="estado" [class.ok]="e.activo">{{ e.activo ? 'Activada' : 'Desactivada' }}</span>
          </div>

          @switch (modo()) {
            @case ('ninguno') {
              @if (!e.activo) {
                <div class="fila acciones"><button type="button" class="btn primary" (click)="empezar()"><app-icon name="lock" [size]="16" /> Activar verificación</button></div>
              } @else {
                <p class="nota">Te quedan <b>{{ e.respaldo_restantes }}</b> códigos de respaldo sin usar.@if (e.exigido) { Es obligatoria para tu rol. }</p>
                <div class="fila acciones">
                  <button type="button" class="btn" (click)="abrir('regenerar')">Generar códigos de respaldo nuevos</button>
                  @if (!e.exigido) { <button type="button" class="btn peligro" (click)="abrir('desactivar')">Desactivar</button> }
                </div>
              }
            }

            @case ('clave') {
              <h4>1. Confirma tu clave</h4>
              <label>Tu clave actual <input type="password" autocomplete="current-password" [value]="clave()" (input)="clave.set($any($event.target).value)" /></label>
              <div class="fila acciones">
                <button type="button" class="btn" (click)="cancelar()">Cancelar</button>
                <button type="button" class="btn primary" [disabled]="ocupado() || !clave()" (click)="preparar()">Continuar</button>
              </div>
            }

            @case ('qr') {
              <h4>2. Escanea el código con tu app</h4>
              <div class="qr-caja">
                <img [src]="qr()" alt="Código QR para tu app de autenticación" width="200" height="200" />
                <div class="qr-txt">
                  <p class="nota">¿No puedes escanear? En tu app elige "Ingresar clave de configuración" y escribe:</p>
                  <code class="secreto">{{ secreto() }}</code>
                </div>
              </div>
              <h4>3. Escribe el código que muestra la app</h4>
              <label>Código de 6 dígitos
                <input inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000" [value]="codigo()" (input)="codigo.set($any($event.target).value)" />
              </label>
              <div class="fila acciones">
                <button type="button" class="btn" (click)="cancelar()">Cancelar</button>
                <button type="button" class="btn primary" [disabled]="ocupado() || codigo().trim().length < 6" (click)="activar()">Activar</button>
              </div>
            }

            @case ('codigos') {
              <h4>Guarda tus códigos de respaldo</h4>
              <p class="nota">Cada código sirve <b>una sola vez</b> y es tu salida si pierdes el teléfono. <b>No se vuelven a mostrar.</b> Guárdalos en un lugar seguro (un gestor de claves o impresos), no en el mismo teléfono.</p>
              <div class="codigos">@for (c of codigosRespaldo(); track c) { <code>{{ c }}</code> }</div>
              <div class="fila acciones">
                <button type="button" class="btn" (click)="copiar()">Copiar</button>
                <button type="button" class="btn" (click)="descargar()">Descargar .txt</button>
              </div>
              <label class="chk"><input type="checkbox" [checked]="guardados()" (change)="guardados.set($any($event.target).checked)" /> Ya guardé mis códigos de respaldo</label>
              <div class="fila acciones"><button type="button" class="btn primary" [disabled]="!guardados()" (click)="terminar()">Listo</button></div>
            }

            @case ('desactivar') {
              <h4>Desactivar la verificación en dos pasos</h4>
              <p class="nota">Por seguridad se cerrará tu sesión y tendrás que entrar de nuevo.</p>
              <div class="grid2">
                <label>Tu clave actual <input type="password" autocomplete="current-password" [value]="clave()" (input)="clave.set($any($event.target).value)" /></label>
                <label>Código de tu app o de respaldo <input autocomplete="one-time-code" maxlength="12" [value]="codigo()" (input)="codigo.set($any($event.target).value)" /></label>
              </div>
              <div class="fila acciones">
                <button type="button" class="btn" (click)="cancelar()">Cancelar</button>
                <button type="button" class="btn peligro" [disabled]="ocupado() || !clave() || codigo().trim().length < 6" (click)="desactivar()">Desactivar</button>
              </div>
            }

            @case ('regenerar') {
              <h4>Generar códigos de respaldo nuevos</h4>
              <p class="nota">Los códigos anteriores dejan de servir.</p>
              <div class="grid2">
                <label>Tu clave actual <input type="password" autocomplete="current-password" [value]="clave()" (input)="clave.set($any($event.target).value)" /></label>
                <label>Código de tu app <input inputmode="numeric" autocomplete="one-time-code" maxlength="7" [value]="codigo()" (input)="codigo.set($any($event.target).value)" /></label>
              </div>
              <div class="fila acciones">
                <button type="button" class="btn" (click)="cancelar()">Cancelar</button>
                <button type="button" class="btn primary" [disabled]="ocupado() || !clave() || codigo().trim().length < 6" (click)="regenerar()">Generar</button>
              </div>
            }
          }
        </section>
      }
    </div>
  `,
  styles: [ESTILOS_ADMIN, `
    h4 { margin: 18px 0 8px; }
    .qr-caja { display: flex; gap: 22px; align-items: center; flex-wrap: wrap; padding: 16px; background: #f8faff; border: 1px solid var(--line); border-radius: 14px; }
    .qr-caja img { border-radius: 10px; background: #fff; padding: 6px; border: 1px solid var(--line); }
    .qr-txt { flex: 1; min-width: 220px; } .secreto { display: block; margin-top: 6px; padding: 10px 12px; border-radius: 10px; background: #fff; border: 1px dashed #b5c2e0; font-size: .95rem; letter-spacing: .08em; word-break: break-all; user-select: all; }
    .codigos { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin: 12px 0; }
    .codigos code { padding: 10px 12px; text-align: center; border-radius: 10px; background: #f1f5f9; font-size: 1rem; font-weight: 600; letter-spacing: .08em; }
    .chk { display: flex; flex-direction: row; align-items: center; gap: 10px; font-weight: 600; cursor: pointer; margin-top: 8px; } .chk input { width: 18px; height: 18px; accent-color: var(--brand); }
  `],
})
export class SeguridadPage implements OnInit {
  private readonly api: DosPasosService = inject(DosPasosService);
  private readonly router: Router = inject(Router);
  readonly auth: AuthService = inject(AuthService);

  readonly estado = signal<Estado2fa | null>(null);
  readonly modo = signal<Modo>('ninguno');
  readonly clave = signal<string>('');
  readonly codigo = signal<string>('');
  readonly qr = signal<string>('');
  readonly secreto = signal<string>('');
  readonly codigosRespaldo = signal<string[]>([]);
  readonly guardados = signal<boolean>(false);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly ocupado = signal<boolean>(false);
  readonly debe = computed<boolean>(() => this.auth.usuario()?.debe_activar_2fa === true);

  ngOnInit(): void { this.cargar(); }

  private cargar(): void {
    this.api.estado().subscribe({ next: (e) => this.estado.set(e), error: (er: HttpErrorResponse) => this.fallo(er) });
  }

  private fallo(e: HttpErrorResponse): void {
    this.mensaje.set('');
    this.ocupado.set(false);
    const d = e.error?.detail;
    this.error.set(typeof d === 'string' ? d : 'No se pudo conectar con el servidor');
  }

  private limpiar(): void { this.clave.set(''); this.codigo.set(''); this.error.set(''); }
  empezar(): void { this.limpiar(); this.mensaje.set(''); this.modo.set('clave'); }
  abrir(m: Modo): void { this.limpiar(); this.mensaje.set(''); this.modo.set(m); }
  cancelar(): void { this.limpiar(); this.modo.set('ninguno'); }

  preparar(): void {
    this.ocupado.set(true);
    this.error.set('');
    this.api.preparar(this.clave()).subscribe({
      next: (r) => { this.ocupado.set(false); this.qr.set(r.qr); this.secreto.set(r.secreto); this.clave.set(''); this.modo.set('qr'); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  activar(): void {
    this.ocupado.set(true);
    this.error.set('');
    this.api.activar(this.codigo().trim()).subscribe({
      next: (r) => {
        this.ocupado.set(false); this.codigo.set(''); this.qr.set(''); this.secreto.set('');
        this.codigosRespaldo.set(r.codigos); this.guardados.set(false); this.modo.set('codigos');
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  regenerar(): void {
    this.ocupado.set(true);
    this.error.set('');
    this.api.respaldo(this.clave(), this.codigo().trim()).subscribe({
      next: (r) => { this.ocupado.set(false); this.limpiar(); this.codigosRespaldo.set(r.codigos); this.guardados.set(false); this.modo.set('codigos'); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  desactivar(): void {
    this.ocupado.set(true);
    this.error.set('');
    this.api.desactivar(this.clave(), this.codigo().trim()).subscribe({
      next: () => { this.ocupado.set(false); this.auth.salir(); void this.router.navigate(['/login']); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  async copiar(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.codigosRespaldo().join('\n'));
      this.error.set(''); this.mensaje.set('Códigos copiados');
    } catch {
      this.mensaje.set(''); this.error.set('No se pudo copiar. Usa "Descargar .txt".');
    }
  }

  descargar(): void {
    const texto = `Códigos de respaldo (cada uno sirve una sola vez)\nCuenta: ${this.auth.usuario()?.usuario ?? ''}\n\n${this.codigosRespaldo().join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([texto], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'codigos-respaldo.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  terminar(): void {
    this.codigosRespaldo.set([]);
    this.modo.set('ninguno');
    const eraObligatoria = this.debe();
    this.auth.refrescar().subscribe({
      next: () => {
        this.cargar();
        this.error.set('');
        this.mensaje.set('Verificación en dos pasos activada');
        if (eraObligatoria) void this.router.navigate(['/']);
      },
      error: () => this.cargar(),
    });
  }
}