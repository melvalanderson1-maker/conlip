import { ChangeDetectionStrategy, Component, DestroyRef, Injectable, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';

interface Vencimiento {
  id: number; empresa_id: number; empresa: string; correo: string; plan: string; modo: 'ver' | 'cotizar';
  vence_en: string; dias: number; vencida: boolean; avisos: number[];
}
interface EstadoAvisos { activo: boolean; dias: number[]; permitidos: number[]; proximos: Vencimiento[]; }
type Filtro = 'todos' | 'semana' | 'vencidos';

const MODOS: Record<string, string> = { ver: 'Solo visualizar', cotizar: 'Visualizar y cotizar' };

@Injectable({ providedIn: 'root' })
export class AvisosService {
  private readonly http: HttpClient = inject(HttpClient);
  private readonly base = `${API}/avisos/admin`;
  ver(): Observable<EstadoAvisos> { return this.http.get<EstadoAvisos>(this.base); }
  guardar(d: { activo: boolean; dias: number[] }): Observable<unknown> { return this.http.put(`${this.base}/config`, d); }
  enviar(id: number): Observable<{ ok: boolean; correo: string }> { return this.http.post<{ ok: boolean; correo: string }>(`${this.base}/enviar/${id}`, {}); }
}

@Component({
  selector: 'app-avisos-admin',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <header class="cab">
        <div>
          <span class="eyebrow">Clientes</span>
          <h2>Avisos de vencimiento</h2>
          <p class="sub">Cada cliente recibe un correo antes de que venza su acceso, con un botón para renovar. Se revisa solo cada 30 minutos.</p>
        </div>
      </header>

      @if (mensaje()) { <p class="ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
      @if (error()) { <p class="error"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

      <section class="card">
        <h3>Configuración</h3>
        <label class="chk">
          <input type="checkbox" [checked]="activo()" (change)="cambiarActivo($any($event.target).checked)" />
          Enviar avisos automáticos de vencimiento
        </label>
        <p class="nota">Además de los días que marques, se envía un aviso cuando el acceso ya venció (una sola vez). Todos los planes que vencen cerca van en un solo correo por empresa.</p>
        <div class="dias" [class.off]="!activo()">
          @for (d of permitidos(); track d) {
            <label class="dia" [class.on]="diasSel().includes(d)">
              <input type="checkbox" [checked]="diasSel().includes(d)" [disabled]="!activo()" (change)="alternarDia(d, $any($event.target).checked)" />
              {{ d }} {{ d === 1 ? 'día' : 'días' }} antes
            </label>
          }
        </div>
        <div class="fila acciones"><button type="button" class="btn primary" (click)="guardar()">Guardar</button></div>
      </section>

      <h3 class="t2">Próximos vencimientos</h3>
      <div class="chips">
        <button type="button" class="chip" [class.on]="filtro() === 'todos'" (click)="filtro.set('todos')">Todos ({{ cuenta('todos') }})</button>
        <button type="button" class="chip" [class.on]="filtro() === 'semana'" (click)="filtro.set('semana')">Esta semana ({{ cuenta('semana') }})</button>
        <button type="button" class="chip" [class.on]="filtro() === 'vencidos'" (click)="filtro.set('vencidos')">Vencidos ({{ cuenta('vencidos') }})</button>
      </div>

      <div class="tabla-wrap">
        <table class="tabla">
          <thead><tr><th>Cliente</th><th>Plan</th><th>Vence</th><th>Avisos enviados</th><th></th></tr></thead>
          <tbody>
            @for (v of visibles(); track v.id) {
              <tr>
                <td><b>{{ v.empresa }}</b><small>{{ v.correo }}</small></td>
                <td>{{ v.plan }}<small>{{ modo(v.modo) }} · suscripción #{{ v.id }}</small></td>
                <td>
                  {{ fecha(v.vence_en) }}
                  <small [class.vencida]="v.vencida" [class.pronto]="!v.vencida && v.dias <= 7">
                    {{ v.vencida ? 'Venció' : (v.dias <= 1 ? 'En menos de 24 horas' : 'En ' + v.dias + ' días') }}
                  </small>
                </td>
                <td>
                  @for (a of v.avisos; track a) { <span class="env">{{ a === 0 ? 'Venció' : a + ' d' }}</span> }
                  @empty { <small>Ninguno aún</small> }
                </td>
                <td class="btns"><button type="button" class="btn" (click)="enviar(v)"><app-icon name="mail" [size]="15" /> Enviar aviso ahora</button></td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="vacio">No hay vencimientos en esta vista.</td></tr>
            }
          </tbody>
        </table>
      </div>
      <p class="nota">Se muestran los que vencen en los próximos 45 días y los que vencieron en los últimos 15.</p>
    </div>
  `,
  styles: [ESTILOS_ADMIN, `
    .t2 { margin: 26px 0 10px; font-size: 1.05rem; }
    .chk { display: flex; flex-direction: row; align-items: center; gap: 10px; font-weight: 600; cursor: pointer; } .chk input { width: 18px; height: 18px; accent-color: var(--brand); }
    .dias { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; } .dias.off { opacity: .45; }
    .dia { display: inline-flex; flex-direction: row; align-items: center; gap: 8px; padding: 9px 16px; border: 1px solid var(--line); border-radius: 999px; background: #fff; font-weight: 600; cursor: pointer; }
    .dia input { display: none; } .dia.on { background: var(--soft); border-color: var(--brand); color: var(--brand); }
    .env { display: inline-block; margin: 0 4px 2px 0; padding: 2px 9px; border-radius: 999px; background: #d1fae5; color: #047857; font-size: .74rem; font-weight: 700; }
    small.vencida { color: #b91c1c !important; font-weight: 700; } small.pronto { color: #b45309 !important; font-weight: 700; }
  `],
})
export class AvisosAdminPage implements OnInit {
  private readonly api: AvisosService = inject(AvisosService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);

  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly activo = signal<boolean>(true);
  readonly diasSel = signal<number[]>([]);
  readonly permitidos = signal<number[]>([14, 7, 3, 1]);
  readonly proximos = signal<Vencimiento[]>([]);
  readonly filtro = signal<Filtro>('todos');
  private sucio = false;  // si estás editando la configuración, un cambio en vivo no la pisa

  readonly visibles = computed<Vencimiento[]>(() => this.proximos().filter((v) => this.coincide(v, this.filtro())));

  ngOnInit(): void {
    this.cargar(true);
    // Tiempo real: renovaciones y cambios de suscripción actualizan la lista sin recargar
    this.rt.cambios('acceso').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargar(false));
  }

  private coincide(v: Vencimiento, f: Filtro): boolean {
    if (f === 'vencidos') return v.vencida;
    if (f === 'semana') return !v.vencida && v.dias <= 7;
    return true;
  }
  cuenta(f: Filtro): number { return this.proximos().filter((v) => this.coincide(v, f)).length; }
  modo(m: string): string { return MODOS[m] ?? m; }
  fecha(iso: string): string {
    return new Date(iso).toLocaleDateString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: 'short', year: 'numeric' });
  }

  private cargar(primera: boolean): void {
    this.api.ver().subscribe({
      next: (e) => {
        this.proximos.set(e.proximos);
        this.permitidos.set(e.permitidos);
        if (primera || !this.sucio) { this.activo.set(e.activo); this.diasSel.set(e.dias); }
      },
      error: (er: HttpErrorResponse) => this.fallo(er),
    });
  }

  private fallo(e: HttpErrorResponse): void {
    this.mensaje.set('');
    const d = e.error?.detail;
    this.error.set(typeof d === 'string' ? d : 'No se pudo conectar con el servidor');
  }

  cambiarActivo(v: boolean): void { this.sucio = true; this.activo.set(v); }
  alternarDia(d: number, on: boolean): void {
    this.sucio = true;
    this.diasSel.update((l) => (on ? [...new Set([...l, d])] : l.filter((x) => x !== d)).sort((a, b) => b - a));
  }

  guardar(): void {
    this.api.guardar({ activo: this.activo(), dias: this.diasSel() }).subscribe({
      next: () => { this.sucio = false; this.error.set(''); this.mensaje.set('Configuración guardada'); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  enviar(v: Vencimiento): void {
    if (!confirm(`¿Enviar ahora el aviso de vencimiento a ${v.correo}?`)) return;
    this.api.enviar(v.id).subscribe({
      next: (r) => { this.error.set(''); this.mensaje.set(`Aviso enviado a ${r.correo}`); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }
}