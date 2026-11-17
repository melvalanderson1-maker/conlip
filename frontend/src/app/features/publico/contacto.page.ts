import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { API } from '../../core/api';

interface CampoPublico {
  id: string; tipo: 'texto' | 'telefono' | 'correo' | 'numero' | 'area' | 'lista' | 'casilla';
  etiqueta: string; requerido: boolean; opciones: string[]; ayuda: string;
}
interface ConfigForm {
  slug: string; nombre: string; titulo: string; descripcion: string; boton: string;
  exito_titulo: string; exito_mensaje: string; campos: CampoPublico[];
}

@Component({
  selector: 'app-contacto',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="pagina">
      <section class="tarjeta">
        @if (noDisponible()) {
          <div class="exito">
            <h1>Este formulario no está disponible</h1>
            <p class="sub">Puede que el enlace esté incompleto o que ya no esté activo.</p>
            <a routerLink="/" class="enlace">← Volver al inicio</a>
          </div>
        } @else if (cfg(); as c) {
          @if (enviado()) {
            <div class="exito">
              <h1>{{ c.exito_titulo }}</h1>
              <p class="sub">{{ c.exito_mensaje }}</p>
              <a routerLink="/" class="enlace">← Volver al inicio</a>
            </div>
          } @else {
            <h1>{{ c.titulo }}</h1>
            @if (c.descripcion) { <p class="sub">{{ c.descripcion }}</p> }

            <form (submit)="$event.preventDefault(); enviar()">
              @for (k of c.campos; track k.id) {
                @switch (k.tipo) {
                  @case ('area') {
                    <label>{{ k.etiqueta }}{{ k.requerido ? ' *' : '' }}
                      <textarea rows="3" maxlength="1000" [value]="texto(k.id)" (input)="poner(k.id, $any($event.target).value)"></textarea>
                      @if (k.ayuda) { <small>{{ k.ayuda }}</small> }
                    </label>
                  }
                  @case ('lista') {
                    <label>{{ k.etiqueta }}{{ k.requerido ? ' *' : '' }}
                      <select (change)="poner(k.id, $any($event.target).value)">
                        <option value="" [selected]="!texto(k.id)">Elige una opción</option>
                        @for (o of k.opciones; track o) { <option [value]="o" [selected]="texto(k.id) === o">{{ o }}</option> }
                      </select>
                      @if (k.ayuda) { <small>{{ k.ayuda }}</small> }
                    </label>
                  }
                  @case ('casilla') {
                    <label class="chk">
                      <input type="checkbox" [checked]="v()[k.id] === true" (change)="poner(k.id, $any($event.target).checked)" />
                      <span>{{ k.etiqueta }}{{ k.requerido ? ' *' : '' }}</span>
                    </label>
                  }
                  @default {
                    <label>{{ k.etiqueta }}{{ k.requerido ? ' *' : '' }}
                      <input [type]="tipoInput(k.tipo)" [attr.inputmode]="modo(k.tipo)" maxlength="200"
                             [value]="texto(k.id)" (input)="poner(k.id, $any($event.target).value)" />
                      @if (k.ayuda) { <small>{{ k.ayuda }}</small> }
                    </label>
                  }
                }
              }

              <!-- Trampa para bots: está fuera de la pantalla y una persona nunca la llena -->
              <div class="trampa" aria-hidden="true">
                <label>Sitio web <input tabindex="-1" autocomplete="off" [value]="sitio()" (input)="sitio.set($any($event.target).value)" /></label>
              </div>

              <label class="chk">
                <input type="checkbox" [checked]="acepto()" (change)="acepto.set($any($event.target).checked)" />
                <span>Acepto la <a routerLink="/privacidad" target="_blank">política de privacidad</a> y que me contacten.</span>
              </label>

              @if (error()) { <p class="error" role="alert">{{ error() }}</p> }

              <button type="submit" class="boton" [disabled]="enviando()">{{ enviando() ? 'Enviando…' : c.boton }}</button>
            </form>
          }
        } @else {
          <p class="sub">Cargando…</p>
        }
      </section>
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: linear-gradient(155deg, #070d24, #14183f 55%, #3a0f2b); font-family: 'Inter', system-ui, sans-serif; }
    * { box-sizing: border-box; }
    .pagina { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }
    .tarjeta { width: 100%; max-width: 560px; padding: 32px; border-radius: 22px; background: #fff; box-shadow: 0 30px 70px rgb(2 6 23 / .55); }
    h1 { margin: 0 0 6px; font-size: 1.5rem; color: #0f172a; }
    .sub { margin: 0 0 20px; color: #64748b; }
    form { display: flex; flex-direction: column; gap: 14px; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: .86rem; font-weight: 700; color: #1e293b; }
    label small { font-weight: 400; color: #64748b; }
    input, textarea, select { padding: 12px 14px; border: 1.5px solid #cbd5e1; border-radius: 12px; font: inherit; font-weight: 400; background: #f8fafc; }
    input:focus, textarea:focus, select:focus { outline: 0; border-color: #2563eb; background: #fff; box-shadow: 0 0 0 4px rgb(37 99 235 / .15); }
    .trampa { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
    .chk { flex-direction: row; align-items: flex-start; gap: 10px; font-weight: 500; font-size: .84rem; }
    .chk input { width: 18px; height: 18px; margin-top: 2px; flex: none; accent-color: #2563eb; }
    .chk a, .enlace { color: #1d4ed8; font-weight: 600; }
    .error { margin: 0; padding: 10px 12px; border-radius: 10px; background: #fff1f2; border: 1px solid #fecdd3; color: #be123c; font-size: .86rem; font-weight: 600; }
    .boton { padding: 14px; border: 0; border-radius: 12px; color: #fff; font: inherit; font-weight: 700; cursor: pointer; background: linear-gradient(100deg, #1d4ed8, #2563eb 45%, #e11d48); }
    .boton:disabled { opacity: .55; cursor: not-allowed; }
    .exito { text-align: center; padding: 24px 0; }
    @media (max-width: 520px) { .tarjeta { padding: 22px 18px; } }
  `],
})
export class ContactoPage implements OnInit {
  private readonly http: HttpClient = inject(HttpClient);
  private readonly ruta: ActivatedRoute = inject(ActivatedRoute);

  readonly cfg = signal<ConfigForm | null>(null);
  readonly noDisponible = signal<boolean>(false);
  readonly v = signal<Record<string, string | boolean>>({});
  readonly sitio = signal<string>('');
  readonly acepto = signal<boolean>(false);
  readonly enviando = signal<boolean>(false);
  readonly enviado = signal<boolean>(false);
  readonly error = signal<string>('');
  private slug = 'contacto';

  ngOnInit(): void {
    const s = this.ruta.snapshot;
    this.slug = s.paramMap.get('slug') ?? (s.data['slug'] as string | undefined) ?? 'contacto';
    this.http.get<ConfigForm>(`${API}/publico/formularios/${this.slug}`).subscribe({
      next: (c) => this.cfg.set(c),
      error: () => this.noDisponible.set(true),
    });
  }

  texto(id: string): string { const x = this.v()[id]; return typeof x === 'string' ? x : ''; }
  poner(id: string, valor: string | boolean): void { this.v.update((x) => ({ ...x, [id]: valor })); }
  tipoInput(t: string): string { return t === 'correo' ? 'email' : t === 'telefono' ? 'tel' : t === 'numero' ? 'number' : 'text'; }
  modo(t: string): string | null { return t === 'numero' ? 'decimal' : t === 'telefono' ? 'tel' : null; }

  enviar(): void {
    const c = this.cfg();
    if (!c || this.enviando()) return;
    for (const k of c.campos) {
      if (!k.requerido) continue;
      const x = this.v()[k.id];
      if (k.tipo === 'casilla' ? x !== true : !(typeof x === 'string' && x.trim())) {
        this.error.set(k.tipo === 'casilla' ? `Debes marcar «${k.etiqueta}»` : `Completa «${k.etiqueta}»`);
        return;
      }
    }
    if (!this.acepto()) { this.error.set('Debes aceptar la política de privacidad'); return; }
    const origenUrl = (this.ruta.snapshot.queryParamMap.get('origen') ?? '').toLowerCase();
    this.error.set('');
    this.enviando.set(true);
    this.http.post(`${API}/publico/formularios/${this.slug}`, {
      valores: this.v(), acepto_privacidad: true, origen: /^[a-z]{3,20}$/.test(origenUrl) ? origenUrl : '', sitio: this.sitio(),
    }).subscribe({
      next: () => { this.enviando.set(false); this.enviado.set(true); },
      error: (e: HttpErrorResponse) => {
        this.enviando.set(false);
        const det = e.error?.detail;
        this.error.set(typeof det === 'string' ? det : 'No se pudo enviar. Revisa los datos e inténtalo de nuevo.');
      },
    });
  }
}