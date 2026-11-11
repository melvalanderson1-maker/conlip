import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, inject, input, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { IconComponent } from '../../shared/icon.component';
import { Conversacion, Mensaje, Plantilla, WhatsappService } from './crm-whatsapp.service';

const ZONA = 'America/Lima';
const ESTADOS: Record<string, string> = { recibido: '', enviado: 'Enviado', entregado: 'Entregado', leido: 'Leído', fallido: 'No se entregó' };

@Component({
  selector: 'app-crm-conversacion',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="wa">
      <div class="wa-cab">
        <h4>Conversación de WhatsApp</h4>
        @if (conv(); as c) {
          @if (c.configurado && c.telefono) {
            <span class="vent" [class.ok]="c.puede_texto_libre">
              {{ c.puede_texto_libre ? 'Puedes responder hasta ' + hora(c.ventana_hasta) : 'Fuera de la ventana de 24 h: solo plantillas' }}
            </span>
          }
        }
      </div>

      @if (conv(); as c) {
        @if (!c.configurado) {
          <p class="nota">WhatsApp Business todavía no está conectado. El superadmin lo configura en CRM → Conexiones.</p>
        } @else if (!c.telefono) {
          <p class="nota">Este lead no tiene teléfono. Agrégalo en «Datos» para poder escribirle.</p>
        } @else {
          <div class="chat" #caja>
            @for (m of c.mensajes; track m.id) {
              <div class="burbuja" [class.sal]="m.direccion === 'out'" [class.mal]="m.estado === 'fallido'">
                @if (m.tiene_media) {
                  @if (esImagen(m)) {
                    @if (imagenes()[m.id]; as u) { <img class="img" [src]="u" alt="Imagen enviada" /> }
                    @else { <button type="button" class="btn" (click)="cargarImagen(m)">Ver imagen</button> }
                  } @else {
                    <button type="button" class="btn" (click)="descargar(m)">{{ m.media_nombre || (m.tipo === 'audio' ? 'Escuchar audio' : 'Descargar archivo') }}</button>
                  }
                }
                @if (m.texto) { <p>{{ m.texto }}</p> }
                <small>{{ hora(m.creado_en) }}@if (m.direccion === 'out') { · {{ estado(m.estado) }}@if (m.enviado_por) { · {{ m.enviado_por }} } }</small>
                @if (m.error) { <small class="err">{{ m.error }}</small> }
              </div>
            } @empty { <p class="nota">Todavía no hay mensajes. Cuando el cliente escriba, aparecerán aquí al instante.</p> }
          </div>

          @if (error()) { <p class="error">{{ error() }}</p> }
          @if (c.puede_texto_libre) {
            <div class="compositor">
              <textarea rows="2" maxlength="4000" placeholder="Escribe tu respuesta (Enter envía, Shift+Enter hace un salto de línea)"
                        [value]="texto()" (input)="texto.set($any($event.target).value)" (keydown.enter)="enter($event)"></textarea>
              <button type="button" class="btn primary" [disabled]="enviando() || !texto().trim()" (click)="enviar()">Enviar</button>
            </div>
          } @else {
            <div class="fila acciones"><button type="button" class="btn primary" (click)="abrirPlantillas()">Enviar una plantilla</button></div>
          }
        }
      } @else { <p class="nota">Cargando…</p> }
    </section>

    @if (modal()) {
      <div class="overlay" (click)="modal.set(false)">
        <div class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab"><h3>Enviar una plantilla</h3><button type="button" class="btn ico" aria-label="Cerrar" (click)="modal.set(false)"><app-icon name="x" [size]="18" /></button></header>
          @if (plantillas() === null) { <p class="nota">Cargando plantillas…</p> }
          @else if (!plantillas()!.length) { <p class="nota">No hay plantillas aprobadas que se puedan enviar desde aquí. Crea y aprueba una en el Administrador de WhatsApp de Meta (por ahora solo texto con variables en el cuerpo).</p> }
          @else {
            <label>Plantilla
              <select (change)="elegir($any($event.target).value)">
                <option value="">Elige una…</option>
                @for (p of plantillas(); track p.nombre + p.idioma) { <option [value]="p.nombre + '|' + p.idioma">{{ p.nombre }} ({{ p.idioma }})</option> }
              </select>
            </label>
            @if (sel(); as p) {
              @for (v of vars(); track $index; let i = $index) {
                <label>Variable {{ i + 1 }} <input maxlength="500" [value]="v" (input)="cambiarVar(i, $any($event.target).value)" /></label>
              }
              <div class="vista"><small>Así lo verá el cliente</small><p>{{ vista(p) }}</p></div>
            }
          }
          @if (errorModal()) { <p class="error">{{ errorModal() }}</p> }
          <div class="pie">
            <button type="button" class="btn" (click)="modal.set(false)">Cancelar</button>
            <button type="button" class="btn primary" [disabled]="!sel() || enviando()" (click)="enviarPlantilla()">Enviar plantilla</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; --line: #e2e8f4; --muted: #5a6784; --brand: #1d4ed8; }
    .wa { padding: 14px; border: 1px solid var(--line); border-radius: 14px; background: #fff; display: flex; flex-direction: column; gap: 10px; }
    .wa-cab { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; } h4 { margin: 0; }
    .vent { padding: 3px 10px; border-radius: 999px; background: #fef3c7; color: #92400e; font-size: .74rem; font-weight: 700; } .vent.ok { background: #d1fae5; color: #047857; }
    .chat { display: flex; flex-direction: column; gap: 8px; max-height: 340px; overflow-y: auto; padding: 10px; border-radius: 12px; background: #efeae2; }
    .burbuja { align-self: flex-start; max-width: 82%; padding: 8px 12px; border-radius: 12px 12px 12px 4px; background: #fff; box-shadow: 0 1px 1px rgb(0 0 0 / .08); display: flex; flex-direction: column; gap: 4px; }
    .burbuja.sal { align-self: flex-end; border-radius: 12px 12px 4px 12px; background: #d9fdd3; } .burbuja.mal { background: #fee2e2; }
    .burbuja p { margin: 0; white-space: pre-wrap; word-break: break-word; line-height: 1.4; } .burbuja small { color: var(--muted); font-size: .7rem; } .burbuja small.err { color: #b91c1c; font-weight: 600; }
    .img { max-width: 100%; max-height: 220px; border-radius: 8px; object-fit: cover; }
    .compositor { display: flex; gap: 8px; align-items: flex-end; } .compositor textarea { flex: 1; padding: 9px 12px; border: 1px solid #cbd5e1; border-radius: 12px; font: inherit; resize: none; }
    .nota { margin: 0; color: var(--muted); font-size: .88rem; } .error { margin: 0; padding: 8px 12px; border-radius: 10px; background: #fef2f2; color: #b91c1c; font-size: .86rem; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 38px; padding: 0 14px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: #0f172a; font: inherit; font-size: .84rem; font-weight: 600; cursor: pointer; }
    .btn.primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, #1d4ed8, #2f6bff); } .btn:disabled { opacity: .5; cursor: not-allowed; } .btn.ico { width: 36px; padding: 0; }
    .fila { display: flex; gap: 8px; } .acciones { justify-content: flex-end; }
    .overlay { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 16px; background: rgb(10 26 58 / .55); }
    .modal { width: min(520px, 100%); display: flex; flex-direction: column; gap: 12px; padding: 20px; background: #fff; border-radius: 18px; max-height: 90vh; overflow-y: auto; }
    .m-cab { display: flex; justify-content: space-between; align-items: center; } .m-cab h3 { margin: 0; } .pie { display: flex; justify-content: flex-end; gap: 8px; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: .84rem; font-weight: 600; } label input, label select { height: 40px; padding: 0 12px; border: 1px solid #cbd5e1; border-radius: 10px; font: inherit; }
    .vista { padding: 10px 14px; border-radius: 12px; background: #f8faff; } .vista small { color: var(--muted); } .vista p { margin: 4px 0 0; white-space: pre-wrap; }
  `],
})
export class CrmConversacionComponent implements OnInit {
  private readonly api: WhatsappService = inject(WhatsappService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);
  readonly leadId = input.required<number>();
  private readonly caja = viewChild<ElementRef<HTMLElement>>('caja');

  readonly conv = signal<Conversacion | null>(null);
  readonly texto = signal<string>('');
  readonly enviando = signal<boolean>(false);
  readonly error = signal<string>('');
  readonly imagenes = signal<Record<number, string>>({});
  readonly modal = signal<boolean>(false);
  readonly plantillas = signal<Plantilla[] | null>(null);
  readonly sel = signal<Plantilla | null>(null);
  readonly vars = signal<string[]>([]);
  readonly errorModal = signal<string>('');

  constructor() {
    this.destroyRef.onDestroy(() => Object.values(this.imagenes()).forEach((u) => URL.revokeObjectURL(u)));
  }

  ngOnInit(): void {
    this.cargar();
    // Tiempo real: un mensaje nuevo o un cambio de estado aparece solo
    this.rt.cambios('crm').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargar());
  }

  private cargar(): void {
    this.api.mensajes(this.leadId()).subscribe({
      next: (c) => {
        this.conv.set(c);
        if (c.no_leidos > 0) this.api.leido(this.leadId()).subscribe({ error: () => undefined });
        c.mensajes.filter((m) => this.esImagen(m) && !this.imagenes()[m.id]).slice(-8).forEach((m) => this.cargarImagen(m));
        setTimeout(() => { const el = this.caja()?.nativeElement; if (el) el.scrollTop = el.scrollHeight; });
      },
      error: () => this.conv.set({ configurado: false, telefono: '', no_leidos: 0, ventana_hasta: null, puede_texto_libre: false, mensajes: [] }),
    });
  }

  hora(iso: string | null): string {
    return iso ? new Date(iso).toLocaleString('es-PE', { timeZone: ZONA, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  }
  estado(e: string): string { return ESTADOS[e] ?? e; }
  esImagen(m: Mensaje): boolean { return m.tiene_media && (m.tipo === 'image' || m.tipo === 'sticker'); }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    return typeof d === 'string' ? d : 'No se pudo conectar con el servidor';
  }

  cargarImagen(m: Mensaje): void {
    this.api.media(m.id).subscribe({
      next: (b) => this.imagenes.update((x) => ({ ...x, [m.id]: URL.createObjectURL(b) })),
      error: () => undefined,
    });
  }

  descargar(m: Mensaje): void {
    this.api.media(m.id).subscribe({
      next: (b) => {
        const url = URL.createObjectURL(b);
        const a = document.createElement('a');
        a.href = url;
        a.download = m.media_nombre || `${m.tipo}-${m.id}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      },
      error: (e: HttpErrorResponse) => this.error.set(this.msg(e)),
    });
  }

  enter(ev: Event): void {
    if ((ev as KeyboardEvent).shiftKey) return;
    ev.preventDefault();
    this.enviar();
  }

  enviar(): void {
    const t = this.texto().trim();
    if (!t || this.enviando()) return;
    this.enviando.set(true);
    this.error.set('');
    this.api.enviar(this.leadId(), t).subscribe({
      next: () => { this.enviando.set(false); this.texto.set(''); this.cargar(); },
      error: (e: HttpErrorResponse) => { this.enviando.set(false); this.error.set(this.msg(e)); this.cargar(); },
    });
  }

  // ---------------- Plantillas ----------------
  abrirPlantillas(): void {
    this.sel.set(null); this.vars.set([]); this.errorModal.set(''); this.modal.set(true);
    this.api.plantillas().subscribe({
      next: (p) => this.plantillas.set(p),
      error: (e: HttpErrorResponse) => { this.plantillas.set([]); this.errorModal.set(this.msg(e)); },
    });
  }

  elegir(valor: string): void {
    const [nombre, idioma] = valor.split('|');
    const p = (this.plantillas() ?? []).find((x) => x.nombre === nombre && x.idioma === idioma) ?? null;
    this.sel.set(p);
    this.vars.set(p ? Array.from({ length: p.variables }, () => '') : []);
  }

  cambiarVar(i: number, v: string): void { this.vars.update((l) => l.map((x, j) => (j === i ? v : x))); }

  vista(p: Plantilla): string {
    return p.cuerpo.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => this.vars()[Number(n) - 1] || `[variable ${n}]`);
  }

  enviarPlantilla(): void {
    const p = this.sel();
    if (!p || this.enviando()) return;
    this.enviando.set(true);
    this.errorModal.set('');
    this.api.plantilla(this.leadId(), { nombre: p.nombre, idioma: p.idioma, variables: this.vars() }).subscribe({
      next: () => { this.enviando.set(false); this.modal.set(false); this.cargar(); },
      error: (e: HttpErrorResponse) => { this.enviando.set(false); this.errorModal.set(this.msg(e)); },
    });
  }
}