import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-verificar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="caja">
      <form class="card" (submit)="enviar($event)">
        <span class="logo">C</span>
        <h1>Verificación en dos pasos</h1>
        <p class="sub">
          {{ respaldo() ? 'Escribe uno de tus códigos de respaldo (cada uno sirve una sola vez).' : 'Abre tu app de autenticación y escribe el código de 6 dígitos.' }}
        </p>
        <input class="codigo" [value]="codigo()" (input)="codigo.set($any($event.target).value)"
               [attr.inputmode]="respaldo() ? 'text' : 'numeric'" autocomplete="one-time-code" autofocus
               [maxLength]="respaldo() ? 12 : 7" [placeholder]="respaldo() ? 'XXXXX-XXXXX' : '000000'" aria-label="Código de verificación" />
        @if (error()) { <p class="error">{{ error() }}</p> }
        <button type="submit" class="btn" [disabled]="ocupado() || codigo().trim().length < 6">
          {{ ocupado() ? 'Verificando…' : 'Verificar' }}
        </button>
        <button type="button" class="enlace" (click)="alternar()">
          {{ respaldo() ? 'Usar el código de mi app' : 'No tengo mi teléfono: usar un código de respaldo' }}
        </button>
        <button type="button" class="enlace" (click)="volver()">Volver al inicio de sesión</button>
      </form>
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: linear-gradient(160deg, #eef2ff, #f8f9fc); font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; color: #0f172a; }
    .caja { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
    .card { width: min(400px, 100%); display: flex; flex-direction: column; gap: 14px; padding: 32px; text-align: center; background: #fff; border: 1px solid #e6e8f0; border-radius: 20px; box-shadow: 0 30px 70px -40px rgb(15 23 42 / .45); }
    .logo { display: grid; place-items: center; width: 48px; height: 48px; margin: 0 auto; border-radius: 14px; color: #fff; font-weight: 700; font-size: 1.3rem; background: linear-gradient(135deg, #6366f1, #4338ca); }
    h1 { margin: 0; font-size: 1.35rem; letter-spacing: -.01em; } .sub { margin: 0; color: #64748b; font-size: .92rem; line-height: 1.5; }
    .codigo { height: 56px; padding: 0 14px; text-align: center; letter-spacing: .3em; font: inherit; font-size: 1.5rem; font-weight: 600; border: 1px solid #cbd5e1; border-radius: 12px; }
    .codigo:focus { outline: 2px solid #6366f1; outline-offset: 1px; border-color: transparent; }
    .error { margin: 0; padding: 10px 12px; border-radius: 10px; background: #fef2f2; color: #b91c1c; font-size: .88rem; }
    .btn { height: 46px; border: 0; border-radius: 12px; color: #fff; font: inherit; font-weight: 600; cursor: pointer; background: linear-gradient(135deg, #6366f1, #4338ca); }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .enlace { border: 0; background: none; color: #4f46e5; font: inherit; font-size: .88rem; font-weight: 600; cursor: pointer; }
  `],
})
export class VerificarPage implements OnInit {
  private readonly auth: AuthService = inject(AuthService);
  private readonly router: Router = inject(Router);

  readonly codigo = signal<string>('');
  readonly respaldo = signal<boolean>(false);
  readonly error = signal<string>('');
  readonly ocupado = signal<boolean>(false);

  ngOnInit(): void {
    // Sin comprobante (por ejemplo, tras recargar la página) no hay nada que verificar
    if (!this.auth.ticket2fa()) void this.router.navigate(['/login']);
  }

  alternar(): void { this.respaldo.update((v) => !v); this.codigo.set(''); this.error.set(''); }
  volver(): void { this.auth.ticket2fa.set(null); void this.router.navigate(['/login']); }

  enviar(ev: Event): void {
    ev.preventDefault();
    if (this.ocupado() || this.codigo().trim().length < 6) return;
    this.ocupado.set(true);
    this.error.set('');
    this.auth.verificar2fa(this.codigo().trim()).subscribe({
      next: () => { this.ocupado.set(false); void this.router.navigate(['/']); },
      error: (e: HttpErrorResponse) => {
        this.ocupado.set(false);
        this.codigo.set('');
        const d = e.error?.detail;
        this.error.set(typeof d === 'string' ? d : 'No se pudo conectar con el servidor');
      },
    });
  }
}