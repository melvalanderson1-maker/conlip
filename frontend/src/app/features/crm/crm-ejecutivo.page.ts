import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { CrmPanelComponent } from './crm-panel.component';
import { CrmFlagService } from './crm.service';

@Component({
  selector: 'app-crm-ejecutivo',
  imports: [CrmPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <header class="cab">
        <div>
          <span class="eyebrow">Comercial</span>
          <h2>Mi CRM</h2>
          <p class="sub">Tus clientes potenciales y su seguimiento.</p>
        </div>
      </header>
      @if (crm.activo()) {
        <app-crm-panel [esAdmin]="false" />
      } @else {
        <section class="card">
          <h3>El CRM no está disponible</h3>
          <p class="nota">Puede que esté apagado o que tu usuario aún no esté vinculado a un ejecutivo de ventas activo. Consulta con el administrador.</p>
        </section>
      }
    </div>
  `,
  styles: [ESTILOS_ADMIN],
})
export class CrmEjecutivoPage implements OnInit {
  readonly crm: CrmFlagService = inject(CrmFlagService);
  ngOnInit(): void { this.crm.cargar(); }
}