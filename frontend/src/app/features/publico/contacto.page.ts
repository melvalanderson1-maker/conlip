import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { API } from '../../core/api';

interface FormContacto {
  nombre: string; telefono: string; correo: string; empresa: string; interes: string; mensaje: string; sitio: string;
}

@Component({
  selector: 'app-contacto',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="pagina">
      <section class="tarjeta">
        @if (enviado()) {
          <div class="exito">
            <h1>¡Gracias, te contactaremos pronto!</h1>
            <p>Recibimos tus datos. Un ejecutivo de ventas se comunicará contigo.</p>
            <a routerLink="/" class="enlace">← Volver al inicio</a>
          </div>
        } @else {
          <h1>Cuéntanos qué necesitas</h1>
          <p class="sub">Déjanos tus datos y un ejecutivo de ventas te contactará.</p>

          <form (submit)="$event.preventDefault(); enviar()">
            <label>Nombre completo *
              <input autocomplete="name" [value]="f().nombre" (input)="campo('nombre', $any($event.target).value)" />
            </label>
            <div class="dos">
              <label>Teléfono / WhatsApp
                <input type="tel" autocomplete="tel" placeholder="999 888 777" [value]="f().telefono" (input)="campo('telefono', $any($event.target).value)" />
              </label>
              <label>Correo
                <input type="email" autocomplete="email" [value]="f().correo" (input)="campo('correo', $any($event.target).value)" />
              </label>
            </div>
            <label>Empresa (opcional)
              <input autocomplete="organization" [value]="f().empresa" (input)="campo('empresa', $any($event.target).value)" />
            </label>
            <label>¿Qué te interesa?
              <input placeholder="Por ejemplo: Plan Coti Menor" [value]="f().interes" (input)="campo('interes', $any($event.target).value)" />
            </label>
            <label>Mensaje (opcional)
              <textarea rows="3" maxlength="1000" [value]="f().mensaje" (input)="campo('mensaje', $any($event.target).value)"></textarea>
            </label>

            <!-- Trampa para bots: está fuera de la pantalla y una persona nunca la llena -->
            <div class="trampa" aria-hidden="true">
              <label>Sitio web <input tabindex="-1" autocomplete="off" [value]="f().sitio" (input)="campo('sitio', $any($event.target).value)" /></label>
            </div>

            <label class="chk">
              <input type="checkbox" [checked]="acepto()" (change)="acepto.set($any($event.target).checked)" />
              <span>Acepto la <a routerLink="/privacidad" target="_blank">política de privacidad</a> y que me contacten.</span>
            </label>

            @if (error()) { <p class="error" role="alert">{{ error() }}</p> }

            <button type="submit" class="boton" [disabled]="enviando()">{{ enviando() ? 'Enviando…' : 'Enviar' }}</button>
            <small class="nota">Necesitamos al menos un teléfono o un correo para contactarte.</small>
          </form>
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
    input, textarea { padding: 12px 14px; border: 1.5px solid #cbd5e1; border-radius: 12px; font: inherit; font-weight: 400; background: #f8fafc; }
    input:focus, textarea:focus { outline: 0; border-color: #2563eb; background: #fff; box-shadow: 0 0 0 4px rgb(37 99 235 / .15); }
    .dos { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .trampa { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
    .chk { flex-direction: row; align-items: flex-start; gap: 10px; font-weight: 500; font-size: .84rem; }
    .chk input { width: 18px; height: 18px; margin-top: 2px; flex: none; accent-color: #2563eb; }
    .chk a, .enlace { color: #1d4ed8; font-weight: 600; }
    .error { margin: 0; padding: 10px 12px; border-radius: 10px; background: #fff1f2; border: 1px solid #fecdd3; color: #be123c; font-size: .86rem; font-weight: 600; }
    .boton { padding: 14px; border: 0; border-radius: 12px; color: #fff; font: inherit; font-weight: 700; cursor: pointer; background: linear-gradient(100deg, #1d4ed8, #2563eb 45%, #e11d48); }
    .boton:disabled { opacity: .55; cursor: not-allowed; }
    .nota { color: #64748b; text-align: center; }
    .exito { text-align: center; padding: 24px 0; }
    @media (max-width: 520px) { .dos { grid-template-columns: 1fr; } .tarjeta { padding: 22px 18px; } }
  `],
})
export class ContactoPage {
  private readonly http: HttpClient = inject(HttpClient);
  private readonly ruta: ActivatedRoute = inject(ActivatedRoute);

  readonly f = signal<FormContacto>({ nombre: '', telefono: '', correo: '', empresa: '', interes: '', mensaje: '', sitio: '' });
  readonly acepto = signal<boolean>(false);
  readonly enviando = signal<boolean>(false);
  readonly enviado = signal<boolean>(false);
  readonly error = signal<string>('');

  campo(k: keyof FormContacto, v: string): void { this.f.update((x) => ({ ...x, [k]: v })); }

  enviar(): void {
    if (this.enviando()) return;
    const d = this.f();
    if (d.nombre.trim().length < 2) { this.error.set('Escribe tu nombre'); return; }
    if (!d.telefono.trim() && !d.correo.trim()) { this.error.set('Escribe un teléfono o un correo para poder contactarte'); return; }
    if (!this.acepto()) { this.error.set('Debes aceptar la política de privacidad'); return; }
    const origenUrl = (this.ruta.snapshot.queryParamMap.get('origen') ?? '').toLowerCase();
    const origen = /^[a-z]{3,20}$/.test(origenUrl) ? origenUrl : 'web';  // /contacto?origen=tiktok
    this.error.set('');
    this.enviando.set(true);
    this.http.post(`${API}/publico/leads`, {
      nombre: d.nombre.trim(), telefono: d.telefono.trim(), correo: d.correo.trim(), empresa: d.empresa.trim(),
      interes: d.interes.trim(), mensaje: d.mensaje.trim(), origen, acepto_privacidad: true, sitio: d.sitio,
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