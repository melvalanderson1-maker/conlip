import { ChangeDetectionStrategy, Component, DestroyRef, Injectable, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { PublicoRealtimeService } from '../../core/publico-realtime.service';

export interface LegalPublico { sitio: string; actualizado: string; terminos: string; privacidad: string; }

@Injectable({ providedIn: 'root' })
export class LegalService {
  private readonly http: HttpClient = inject(HttpClient);
  legal(): Observable<LegalPublico> { return this.http.get<LegalPublico>(`${API}/publico/legal`); }
}

interface Bloque { t: 'h' | 'p' | 'li'; texto: string; }

/** '# Título' = encabezado, '- texto' = viñeta, cualquier otra línea = párrafo. Todo se muestra como texto (nunca como HTML). */
function aBloques(txt: string): Bloque[] {
  const out: Bloque[] = [];
  for (const crudo of txt.split('\n')) {
    const l = crudo.trim();
    if (!l) continue;
    if (l.startsWith('# ')) out.push({ t: 'h', texto: l.slice(2) });
    else if (l.startsWith('- ')) out.push({ t: 'li', texto: l.slice(2) });
    else out.push({ t: 'p', texto: l });
  }
  return out;
}

@Component({
  selector: 'app-legal',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="nav">
      <div class="nav-in">
        <a class="marca" routerLink="/"><span class="logo">{{ inicial() }}</span><b>{{ sitio() }}</b></a>
        <a class="volver" routerLink="/">Volver al inicio</a>
      </div>
    </header>

    <main class="doc">
      @if (datos()) {
        <span class="eyebrow">Legal</span>
        <h1>{{ titulo() }}</h1>
        @if (datos()?.actualizado) { <p class="fecha">Última actualización: {{ datos()?.actualizado }}</p> }

        @for (b of bloques(); track $index) {
          @switch (b.t) {
            @case ('h') { <h2>{{ b.texto }}</h2> }
            @case ('li') { <p class="li">{{ b.texto }}</p> }
            @default { <p>{{ b.texto }}</p> }
          }
        }

        <nav class="otros">
          @if (tipo === 'terminos') { <a routerLink="/privacidad">Ver la política de privacidad</a> }
          @else { <a routerLink="/terminos">Ver los términos y condiciones</a> }
        </nav>
      } @else if (error()) {
        <p class="error">{{ error() }}</p>
      } @else {
        <p class="cargando">Cargando…</p>
      }
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: #f8f9fc; color: #0f172a; font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; }
    * { box-sizing: border-box; }
    .nav { position: sticky; top: 0; z-index: 10; background: rgb(255 255 255 / .92); backdrop-filter: blur(8px); border-bottom: 1px solid #e6e8f0; }
    .nav-in { max-width: 860px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; }
    .marca { display: flex; align-items: center; gap: 10px; color: inherit; text-decoration: none; font-size: 1.05rem; }
    .logo { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; color: #fff; font-weight: 700; background: linear-gradient(135deg, #6366f1, #4338ca); }
    .volver { color: #4f46e5; font-weight: 600; text-decoration: none; font-size: .9rem; }
    .doc { max-width: 860px; margin: 0 auto; padding: 40px 20px 80px; }
    .eyebrow { display: block; color: #4f46e5; font-size: .78rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 6px 0 6px; font-size: clamp(1.7rem, 4vw, 2.3rem); letter-spacing: -.02em; }
    .fecha { margin: 0 0 28px; color: #64748b; font-size: .9rem; }
    h2 { margin: 30px 0 8px; font-size: 1.15rem; }
    p { margin: 0 0 12px; line-height: 1.7; color: #334155; }
    p.li { position: relative; padding-left: 22px; margin-bottom: 8px; } p.li::before { content: ''; position: absolute; left: 6px; top: .75em; width: 6px; height: 6px; border-radius: 50%; background: #6366f1; }
    .otros { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e6e8f0; } .otros a { color: #4f46e5; font-weight: 600; text-decoration: none; }
    .cargando, .error { text-align: center; padding: 60px 0; color: #64748b; } .error { color: #b91c1c; }
  `],
})
export class LegalPage implements OnInit, OnDestroy {
  private readonly api: LegalService = inject(LegalService);
  private readonly rt: PublicoRealtimeService = inject(PublicoRealtimeService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);
  readonly tipo: 'terminos' | 'privacidad' = (inject(ActivatedRoute).snapshot.data['tipo'] as 'terminos' | 'privacidad') ?? 'terminos';

  readonly datos = signal<LegalPublico | null>(null);
  readonly error = signal<string>('');
  readonly sitio = computed<string>(() => this.datos()?.sitio ?? 'COTI');
  readonly inicial = computed<string>(() => this.sitio().charAt(0).toUpperCase());
  readonly titulo = computed<string>(() => (this.tipo === 'terminos' ? 'Términos y condiciones' : 'Política de privacidad'));
  readonly bloques = computed<Bloque[]>(() => {
    const d = this.datos();
    return d ? aBloques(this.tipo === 'terminos' ? d.terminos : d.privacidad) : [];
  });

  ngOnInit(): void {
    this.cargar();
    // Tiempo real: si el superadmin edita el texto, esta página se actualiza sola
    this.rt.iniciar();
    this.rt.cambios('catalogo').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargar());
  }

  ngOnDestroy(): void { this.rt.detener(); }

  private cargar(): void {
    this.api.legal().subscribe({
      next: (d) => { this.datos.set(d); this.error.set(''); },
      error: () => this.error.set('No pudimos cargar esta página. Intenta de nuevo en unos minutos.'),
    });
  }
}