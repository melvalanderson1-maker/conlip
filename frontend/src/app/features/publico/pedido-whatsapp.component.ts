import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { API } from '../../core/api';

@Component({
  selector: 'app-pedido-whatsapp',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="caja">
      <span class="ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="#fff"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>
      </span>
      <h3>Tu pedido está registrado</h3>
      <p class="cod">Código de pedido: <b>{{ codigo() }}</b></p>
      <p>Envíalo por WhatsApp y un asesor te indicará cómo pagar (Yape, Plin o transferencia). Apenas confirme tu pago activamos tu acceso y te llega un correo para crear tu clave.</p>
      @if (url()) {
        <a class="wa" [href]="url()" target="_blank" rel="noopener" (click)="avisar()">Enviar pedido por WhatsApp</a>
      } @else {
        <p class="aviso">No pudimos abrir WhatsApp automáticamente. Escríbenos indicando tu código de pedido.</p>
      }
      <small>Guarda tu código de pedido: <b>{{ codigo() }}</b></small>
    </div>
  `,
  styles: [`
    .caja { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 26px 22px; text-align: center; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 18px; color: #0f172a; }
    .ico { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 50%; background: #25d366; }
    h3 { margin: 4px 0 0; font-size: 1.2rem; } p { margin: 0; color: #334155; line-height: 1.55; max-width: 460px; } .cod { font-size: 1.05rem; }
    .wa { display: inline-flex; align-items: center; justify-content: center; margin-top: 6px; height: 50px; padding: 0 28px; border-radius: 14px; background: #25d366; color: #fff; font-weight: 700; text-decoration: none; box-shadow: 0 14px 28px -14px rgb(37 211 102 / .9); }
    .wa:hover { filter: brightness(.95); } .aviso { color: #b45309; } small { color: #64748b; }
  `],
})
export class PedidoWhatsappComponent {
  private readonly http: HttpClient = inject(HttpClient);
  readonly codigo = input<string>('');
  readonly url = input<string>('');
  readonly orden = input<string>('');

  /** Se avisa al equipo cuando el cliente realmente pulsa el botón (no por cada carrito abandonado). */
  avisar(): void {
    this.http.post(`${API}/publico/ordenes/${this.orden()}/whatsapp`, {}).subscribe({ error: () => undefined });
  }
}