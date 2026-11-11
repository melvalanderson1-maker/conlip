import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { CheckoutService } from './checkout.service';

@Component({
  selector: 'app-crear-clave',
  imports: [RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <section class="card">
        @if (listo()) {
          <div class="check"><app-icon name="check" [size]="30" /></div>
          <h2>¡Clave creada!</h2>
          <p class="muted">Ya puedes iniciar sesión con tu correo y tu nueva clave.</p>
          <a routerLink="/login" class="btn primary">Iniciar sesión</a>
        } @else if (token()) {
          <h2>Crea tu clave</h2>
          <label>Nueva clave
            <input type="password" autocomplete="new-password" [value]="clave()" (input)="clave.set($any($event.target).value)" />
            <small>Mínimo 10 caracteres, con letras y números.</small>
          </label>
          <label>Repite tu clave
            <input type="password" autocomplete="new-password" [value]="clave2()" (input)="clave2.set($any($event.target).value)" />
          </label>
          @if (error()) { <p class="error">{{ error() }}</p> }
          <button type="button" class="btn primary lg" [disabled]="cargando()" (click)="guardar()">
            {{ cargando() ? 'Guardando…' : 'Guardar clave' }}
          </button>
          <a class="link" routerLink="/crear-clave">¿El enlace venció? Pide uno nuevo</a>
        } @else if (enviado()) {
          <div class="check"><app-icon name="mail" [size]="28" /></div>
          <h2>Revisa tu correo</h2>
          <p class="muted">Si ese correo tiene una cuenta, te enviamos un enlace para crear tu clave. Vence en 24 horas.</p>
        } @else {
          <h2>Crear o recuperar tu clave</h2>
          <p class="muted">Escribe el correo de tu cuenta y te enviaremos un enlace.</p>
          <label>Correo
            <input type="email" autocomplete="email" [value]="correo()" (input)="correo.set($any($event.target).value)" />
          </label>
          @if (error()) { <p class="error">{{ error() }}</p> }
          <button type="button" class="btn primary lg" [disabled]="cargando() || !correo()" (click)="pedirEnlace()">
            {{ cargando() ? 'Enviando…' : 'Enviarme el enlace' }}
          </button>
          <a class="link" routerLink="/login">← Volver a iniciar sesión</a>
        }
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: #f8f9fc; color: #0f172a; font-family: 'Inter', system-ui, sans-serif; --brand: #4f46e5; --line: #e6e8f0; --muted: #64748b; }
    * { box-sizing: border-box; } .wrap { max-width: 440px; margin: 0 auto; padding: 60px 20px; }
    .card { display: flex; flex-direction: column; gap: 14px; padding: 28px; background: #fff; border: 1px solid var(--line); border-radius: 18px; }
    h2 { margin: 0; } .muted { color: var(--muted); margin: 0; font-size: .92rem; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: .85rem; font-weight: 600; } label small { font-weight: 400; color: var(--muted); }
    input { height: 42px; padding: 0 12px; border: 1px solid #cbd5e1; border-radius: 10px; font: inherit; font-weight: 400; }
    .btn { display: inline-flex; align-items: center; justify-content: center; height: 40px; padding: 0 18px; border-radius: 12px; border: 1px solid var(--line); background: #fff; color: #0f172a; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
    .btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; } .btn.lg { height: 46px; } .btn:disabled { opacity: .5; cursor: not-allowed; }
    .link { color: var(--muted); font-size: .88rem; text-align: center; text-decoration: none; }
    .error { margin: 0; padding: 10px 14px; border-radius: 10px; background: #fef2f2; color: #b91c1c; font-size: .88rem; }
    .check { display: grid; place-items: center; width: 60px; height: 60px; margin: 0 auto; border-radius: 50%; background: #d1fae5; color: #047857; font-size: 1.8rem; }
  `],
})
export class CrearClavePage {
  private readonly route: ActivatedRoute = inject(ActivatedRoute);
  private readonly api: CheckoutService = inject(CheckoutService);

  readonly token = signal<string>(this.route.snapshot.queryParamMap.get('token') ?? '');
  readonly clave = signal<string>('');
  readonly clave2 = signal<string>('');
  readonly correo = signal<string>('');
  readonly cargando = signal<boolean>(false);
  readonly listo = signal<boolean>(false);
  readonly enviado = signal<boolean>(false);
  readonly error = signal<string>('');

  guardar(): void {
    this.error.set('');
    if (this.clave() !== this.clave2()) { this.error.set('Las claves no coinciden'); return; }
    this.cargando.set(true);
    this.api.crearClave(this.token(), this.clave()).subscribe({
      next: () => { this.cargando.set(false); this.listo.set(true); },
      error: (e: HttpErrorResponse) => { this.cargando.set(false); this.error.set(this.msg(e)); },
    });
  }

  pedirEnlace(): void {
    this.error.set('');
    this.cargando.set(true);
    this.api.solicitarEnlace(this.correo().trim()).subscribe({
      next: () => { this.cargando.set(false); this.enviado.set(true); },
      error: (e: HttpErrorResponse) => { this.cargando.set(false); this.error.set(this.msg(e)); },
    });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return 'Revisa los datos: la clave necesita mínimo 10 caracteres y el correo debe ser válido.';
    return 'No se pudo conectar con el servidor';
  }
}