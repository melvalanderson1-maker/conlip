import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CheckoutService } from './checkout.service';
import { CatalogoPub, PublicoService } from './publico.service';

@Component({
  selector: 'app-solicitud',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <a routerLink="/" class="volver">← Volver</a>
      @if (enviado()) {
        <section class="card centro">
          <div class="check">✓</div>
          <h2>¡Recibimos tu solicitud!</h2>
          <p class="muted">Te escribiremos pronto al correo {{ correo() }}.</p>
          <a routerLink="/" class="btn primary">Volver al inicio</a>
        </section>
      } @else {
        <section class="card">
          <h2>Solicitar cotización</h2>
          @if (servicio(); as s) {
            <p class="srv"><b>{{ s.nombre }}</b><br /><small>{{ s.categoria }}</small></p>
          } @else if (cargado()) {
            <p class="error">No encontramos ese servicio.</p>
          }
          <label>Nombre o razón social
            <input [value]="nombre()" (input)="nombre.set($any($event.target).value)" />
          </label>
          <label>Correo
            <input type="email" [value]="correo()" (input)="correo.set($any($event.target).value)" />
          </label>
          <label>Teléfono / WhatsApp (opcional)
            <input type="tel" [value]="telefono()" (input)="telefono.set($any($event.target).value)" />
          </label>
          <label>Cuéntanos qué necesitas (opcional)
            <textarea rows="4" maxlength="500" [value]="mensaje()" (input)="mensaje.set($any($event.target).value)"></textarea>
          </label>
          @if (error()) { <p class="error">{{ error() }}</p> }
          <button type="button" class="btn primary lg" [disabled]="enviando() || !servicio()" (click)="enviar()">
            {{ enviando() ? 'Enviando…' : 'Enviar solicitud' }}
          </button>
        </section>
      }
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: #f8f9fc; color: #0f172a; font-family: 'Inter', system-ui, sans-serif; --brand: #4f46e5; --line: #e6e8f0; --muted: #64748b; }
    * { box-sizing: border-box; } .wrap { max-width: 560px; margin: 0 auto; padding: 24px 20px 60px; }
    .volver { color: var(--muted); text-decoration: none; font-size: .9rem; }
    .card { display: flex; flex-direction: column; gap: 14px; margin-top: 14px; padding: 26px; background: #fff; border: 1px solid var(--line); border-radius: 18px; }
    .centro { align-items: center; text-align: center; } h2 { margin: 0; } .muted { color: var(--muted); margin: 0; }
    .srv { margin: 0; padding: 12px 14px; background: #f5f6ff; border-radius: 12px; } .srv small { color: var(--muted); }
    label { display: flex; flex-direction: column; gap: 6px; font-size: .85rem; font-weight: 600; }
    input, textarea { padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font: inherit; font-weight: 400; } input { height: 42px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; height: 40px; padding: 0 18px; border-radius: 12px; border: 1px solid var(--line); background: #fff; color: #0f172a; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
    .btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; } .btn.lg { height: 48px; } .btn:disabled { opacity: .5; cursor: not-allowed; }
    .error { margin: 0; padding: 10px 14px; border-radius: 10px; background: #fef2f2; color: #b91c1c; font-size: .88rem; }
    .check { display: grid; place-items: center; width: 64px; height: 64px; border-radius: 50%; background: #d1fae5; color: #047857; font-size: 2rem; }
  `],
})
export class SolicitudPage implements OnInit {
  private readonly route: ActivatedRoute = inject(ActivatedRoute);
  private readonly publico: PublicoService = inject(PublicoService);
  private readonly api: CheckoutService = inject(CheckoutService);

  private readonly cat = signal<CatalogoPub | null>(null);
  readonly cargado = signal<boolean>(false);
  private readonly servicioId = Number(this.route.snapshot.queryParamMap.get('servicio'));
  readonly servicio = computed(() => this.cat()?.servicios.find((s) => s.id === this.servicioId) ?? null);

  readonly nombre = signal<string>('');
  readonly correo = signal<string>('');
  readonly telefono = signal<string>('');
  readonly mensaje = signal<string>('');
  readonly enviando = signal<boolean>(false);
  readonly enviado = signal<boolean>(false);
  readonly error = signal<string>('');

  ngOnInit(): void {
    this.publico.catalogo().subscribe({
      next: (c) => { this.cat.set(c); this.cargado.set(true); },
      error: () => { this.cargado.set(true); this.error.set('No pudimos cargar la información.'); },
    });
  }

  enviar(): void {
    if (this.enviando()) return;
    if (!this.nombre().trim() || !this.correo().trim()) { this.error.set('Completa tu nombre y correo'); return; }
    this.enviando.set(true);
    this.error.set('');
    this.api.solicitud({
      servicio_id: this.servicioId, nombre: this.nombre().trim(), correo: this.correo().trim(),
      telefono: this.telefono().trim(), mensaje: this.mensaje().trim(),
    }).subscribe({
      next: () => { this.enviando.set(false); this.enviado.set(true); },
      error: (e: HttpErrorResponse) => {
        this.enviando.set(false);
        this.error.set(typeof e.error?.detail === 'string' ? e.error.detail : 'Revisa tu correo y los datos del formulario');
      },
    });
  }
}