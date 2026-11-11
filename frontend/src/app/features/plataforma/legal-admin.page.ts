import { ChangeDetectionStrategy, Component, Injectable, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';

interface LegalAdmin {
  datos: { razon_social: string; ruc: string; domicilio: string; correo: string; ciudad: string };
  terminos: string; privacidad: string; terminos_base: string; privacidad_base: string; actualizado: string; marcas: string[];
}
type Pestana = 'datos' | 'terminos' | 'privacidad';
type Campo = 'razon_social' | 'ruc' | 'domicilio' | 'correo' | 'ciudad';

const ETIQUETAS: Record<Campo, string> = {
  razon_social: 'razón social', ruc: 'RUC', domicilio: 'domicilio', correo: 'correo de contacto', ciudad: 'ciudad',
};

@Injectable({ providedIn: 'root' })
export class LegalAdminService {
  private readonly http: HttpClient = inject(HttpClient);
  ver(): Observable<LegalAdmin> { return this.http.get<LegalAdmin>(`${API}/legal/admin`); }
  guardar(d: Record<string, string>): Observable<unknown> { return this.http.put(`${API}/legal/admin`, d); }
}

@Component({
  selector: 'app-legal-admin',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <header class="cab">
        <div>
          <span class="eyebrow">Sitio</span>
          <h2>Legal</h2>
          <p class="sub">Términos y condiciones y política de privacidad que ven tus clientes en las páginas públicas. Se actualizan al instante al guardar.</p>
        </div>
      </header>

      @if (mensaje()) { <p class="ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
      @if (error()) { <p class="error"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }
      @if (faltan().length) {
        <p class="error"><app-icon name="alert" [size]="18" />
          Faltan datos del titular: {{ faltan().join(', ') }}. Mientras tanto, las páginas públicas muestran «(dato pendiente)».</p>
      }

      <div class="tabs">
        <button type="button" [class.on]="pestana() === 'datos'" (click)="pestana.set('datos')"><app-icon name="building" [size]="16" /> Datos del titular</button>
        <button type="button" [class.on]="pestana() === 'terminos'" (click)="pestana.set('terminos')"><app-icon name="receipt" [size]="16" /> Términos y condiciones</button>
        <button type="button" [class.on]="pestana() === 'privacidad'" (click)="pestana.set('privacidad')"><app-icon name="lock" [size]="16" /> Política de privacidad</button>
      </div>

      @if (pestana() === 'datos') {
        <section class="card">
          <p class="nota">Quién opera la plataforma. Estos datos se insertan en los dos textos.</p>
          <div class="grid2">
            <label>Razón social <input [value]="razon()" (input)="razon.set($any($event.target).value)" /></label>
            <label>RUC (11 dígitos) <input inputmode="numeric" maxlength="11" [value]="ruc()" (input)="ruc.set($any($event.target).value)" /></label>
            <label>Domicilio legal <input [value]="domicilio()" (input)="domicilio.set($any($event.target).value)" /></label>
            <label>Correo para reclamos y derechos sobre datos personales
              <input type="email" [value]="correo()" (input)="correo.set($any($event.target).value)" />
            </label>
            <label>Ciudad de la jurisdicción (por ejemplo: Huancayo) <input [value]="ciudad()" (input)="ciudad.set($any($event.target).value)" /></label>
          </div>
        </section>
      }

      @if (pestana() === 'terminos' || pestana() === 'privacidad') {
        <section class="card">
          <p class="nota">
            Formato: una línea que empieza con «# » es un encabezado, una que empieza con «- » es una viñeta, y cada línea suelta es un párrafo.
            Marcas que se reemplazan solas:
            @for (m of marcas(); track m) { <code>{{ m }}</code> }
          </p>
          @if (pestana() === 'terminos') {
            <textarea rows="26" [value]="terminos()" (input)="terminos.set($any($event.target).value)"></textarea>
          } @else {
            <textarea rows="26" [value]="privacidad()" (input)="privacidad.set($any($event.target).value)"></textarea>
          }
          <div class="fila acciones">
            <button type="button" class="btn" (click)="restaurar()">Restaurar texto base</button>
            <button type="button" class="btn" (click)="verPagina()"><app-icon name="external" [size]="15" /> Ver página pública</button>
          </div>
        </section>
      }

      <div class="fila">
        <button type="button" class="btn primary" [disabled]="guardando()" (click)="guardar()">{{ guardando() ? 'Guardando…' : 'Guardar todo' }}</button>
        @if (actualizado()) { <small class="nota">Última actualización publicada: {{ actualizado() }}</small> }
      </div>
    </div>
  `,
  styles: [ESTILOS_ADMIN, `
    textarea { width: 100%; padding: 12px 14px; border: 1px solid #cbd5e1; border-radius: 12px; font: inherit; font-size: .9rem; line-height: 1.55; resize: vertical; }
    code { display: inline-block; margin: 2px 4px 2px 0; padding: 1px 8px; border-radius: 6px; background: #eef2ff; color: #1d4ed8; font-size: .78rem; }
  `],
})
export class LegalAdminPage implements OnInit {
  private readonly api: LegalAdminService = inject(LegalAdminService);

  readonly pestana = signal<Pestana>('datos');
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly guardando = signal<boolean>(false);
  readonly base = signal<{ terminos: string; privacidad: string }>({ terminos: '', privacidad: '' });
  readonly marcas = signal<string[]>([]);
  readonly actualizado = signal<string>('');

  readonly razon = signal<string>('');
  readonly ruc = signal<string>('');
  readonly domicilio = signal<string>('');
  readonly correo = signal<string>('');
  readonly ciudad = signal<string>('');
  readonly terminos = signal<string>('');
  readonly privacidad = signal<string>('');

  readonly faltan = computed<string[]>(() => {
    const v: Record<Campo, string> = {
      razon_social: this.razon(), ruc: this.ruc(), domicilio: this.domicilio(), correo: this.correo(), ciudad: this.ciudad(),
    };
    return (Object.keys(v) as Campo[]).filter((k) => !v[k].trim()).map((k) => ETIQUETAS[k]);
  });

  ngOnInit(): void {
    this.api.ver().subscribe({
      next: (d) => {
        this.razon.set(d.datos.razon_social); this.ruc.set(d.datos.ruc); this.domicilio.set(d.datos.domicilio);
        this.correo.set(d.datos.correo); this.ciudad.set(d.datos.ciudad);
        this.terminos.set(d.terminos); this.privacidad.set(d.privacidad);
        this.base.set({ terminos: d.terminos_base, privacidad: d.privacidad_base });
        this.marcas.set(d.marcas); this.actualizado.set(d.actualizado);
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  private fallo(e: HttpErrorResponse): void {
    this.mensaje.set('');
    const d = e.error?.detail;
    this.error.set(typeof d === 'string' ? d : 'No se pudo conectar con el servidor');
  }

  restaurar(): void {
    const t = this.pestana();
    if (t === 'datos') return;
    if (!confirm('¿Restaurar el texto base? Se pierden tus cambios de este documento (hasta que guardes).')) return;
    if (t === 'terminos') this.terminos.set(this.base().terminos);
    else this.privacidad.set(this.base().privacidad);
  }

  verPagina(): void { window.open(this.pestana() === 'privacidad' ? '/privacidad' : '/terminos', '_blank', 'noopener'); }

  guardar(): void {
    this.guardando.set(true);
    this.api.guardar({
      razon_social: this.razon(), ruc: this.ruc(), domicilio: this.domicilio(), correo: this.correo(), ciudad: this.ciudad(),
      terminos: this.terminos(), privacidad: this.privacidad(),
    }).subscribe({
      next: () => {
        this.guardando.set(false); this.error.set('');
        this.mensaje.set('Guardado. Las páginas públicas ya muestran los cambios.');
        this.actualizado.set(new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima' }));
      },
      error: (e: HttpErrorResponse) => { this.guardando.set(false); this.fallo(e); },
    });
  }
}