(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.NOVABusinessAdmin = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    const emptyData = () => ({ clientes: [], ventas: [], gastos: [], cajas: [] });
    const views = ['venta', 'fiados', 'clientes', 'gastos', 'caja'];
    const viewLabels = {
        venta: 'Punto de venta',
        fiados: 'Fiados',
        clientes: 'Clientes',
        gastos: 'Gastos',
        caja: 'Cierre de caja'
    };
    const state = {
        root: null,
        data: emptyData(),
        revision: null,
        inventoryRevision: null,
        activeView: 'venta',
        cart: [],
        loaded: false,
        loading: false,
        busy: false,
        message: '',
        messageType: 'info',
        lastLoadedAt: null
    };

    function normalizarTelefono(telefono) {
        return String(telefono || '').replace(/\D/g, '');
    }

    function calcularSaldo(venta) {
        const total = Number(venta?.total) || 0;
        const pagos = Array.isArray(venta?.pagos) ? venta.pagos : [];
        const pagado = pagos.reduce((suma, pago) => suma + (Number(pago.monto) || 0), 0);
        return Math.max(0, Number((total - pagado).toFixed(2)));
    }

    function calcularCaja(data, caja, ahora = new Date()) {
        const inicio = Date.parse(caja?.abiertaEn || caja?.fecha || 0);
        const dentroDePeriodo = valor => {
            const fecha = Date.parse(valor || 0);
            return Number.isFinite(fecha) && fecha >= inicio && fecha <= ahora.getTime();
        };
        const ventasEfectivo = (data?.ventas || []).reduce((suma, venta) => {
            const pagos = Array.isArray(venta.pagos) ? venta.pagos : [];
            return suma + pagos.reduce((parcial, pago) =>
                parcial + (pago.metodo === 'efectivo' && dentroDePeriodo(pago.fecha)
                    ? Number(pago.monto) || 0
                    : 0), 0);
        }, 0);
        const gastosEfectivo = (data?.gastos || []).reduce((suma, gasto) =>
            suma + (gasto.metodoPago === 'efectivo' && dentroDePeriodo(gasto.createdAt)
                ? Number(gasto.monto) || 0
                : 0), 0);
        const fondoInicial = Number(caja?.fondoInicial) || 0;
        const esperado = Number((fondoInicial + ventasEfectivo - gastosEfectivo).toFixed(2));
        return {
            fondoInicial,
            ventasEfectivo: Number(ventasEfectivo.toFixed(2)),
            gastosEfectivo: Number(gastosEfectivo.toFixed(2)),
            esperado,
            contado: Number(caja?.efectivoContado) || 0,
            diferencia: Number(((Number(caja?.efectivoContado) || 0) - esperado).toFixed(2))
        };
    }

    function escaparHTML(valor) {
        return String(valor ?? '').replace(/[&<>"']/g, caracter => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[caracter]);
    }

    function dinero(valor) {
        const numero = Number(valor);
        return `$${(Number.isFinite(numero) ? numero : 0).toFixed(2)}`;
    }

    function fechaLocal() {
        const fecha = new Date();
        return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`;
    }

    function setMessage(mensaje, tipo = 'info') {
        state.message = mensaje;
        state.messageType = tipo;
        renderMessage();
    }

    function renderMessage() {
        const target = state.root?.querySelector('[data-business-message]');
        if (!target) return;
        target.textContent = state.message;
        target.dataset.type = state.messageType;
        target.hidden = !state.message;
    }

    function ensureShell() {
        if (!state.root || state.root.querySelector('[data-business-shell]')) return;
        state.root.innerHTML = `
            <section class="business-shell" data-business-shell>
                <header class="business-heading">
                    <div>
                        <p class="business-eyebrow">MÓDULO COMERCIAL</p>
                        <h2>Administración del negocio</h2>
                        <p>Ventas, clientes, fiados, gastos y caja, separados del catálogo de inventario.</p>
                    </div>
                    <button class="btn secondary" type="button" data-action="refresh">Actualizar datos</button>
                </header>
                <nav class="business-nav" aria-label="Navegación de administración">
                    ${views.map((view, index) => `<button type="button" class="business-nav-btn${index === 0 ? ' active' : ''}" data-view="${view}">${viewLabels[view]}</button>`).join('')}
                </nav>
                <p class="business-message" data-business-message role="status" aria-live="polite" hidden></p>
                <p class="business-sync-note" data-business-sync-note></p>
                <main class="business-page" data-business-page></main>
            </section>`;
        state.root.addEventListener('click', handleClick);
        state.root.addEventListener('submit', handleSubmit);
        state.root.addEventListener('change', handleChange);
    }

    function setBusy(busy) {
        state.busy = busy;
        state.root?.querySelectorAll('button[type="submit"], [data-action="refresh"]').forEach(button => {
            button.disabled = busy;
        });
    }

    async function request(action, data = null, expectedRevision = null) {
        const bridge = root.NOVABusinessBridge;
        if (!bridge) throw new Error('La integración con el inventario aún no está disponible.');
        const config = bridge.getConfig();
        const response = await fetch(`${config.url}/rest/v1/rpc/manage_business_store`, {
            method: 'POST',
            headers: {
                apikey: config.key,
                Authorization: `Bearer ${config.key}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                p_code: config.code,
                p_action: action,
                p_data: data,
                p_expected_revision: expectedRevision
            })
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) {
            const detail = result && (result.message || result.details || result.hint);
            throw new Error(detail || `Supabase respondió con el estado ${response.status}.`);
        }
        if (!result || typeof result !== 'object' || result.ok !== true) {
            throw new Error('Supabase devolvió una respuesta inesperada.');
        }
        return result;
    }

    async function loadData() {
        ensureShell();
        if (state.loading) return;
        state.loading = true;
        setBusy(true);
        setMessage('Conectando con Supabase y cargando los datos del negocio…');
        try {
            const result = await request('read');
            state.data = normalizeData(result.data);
            state.revision = Number(result.revision);
            state.inventoryRevision = Number(result.inventoryRevision);
            state.loaded = true;
            state.lastLoadedAt = new Date();
            setMessage('Datos comerciales cargados desde Supabase.', 'success');
        } catch (error) {
            state.loaded = false;
            const migrationHint = /manage_business_store|function|schema cache|does not exist/i.test(error.message)
                ? ' Ejecuta primero supabase-business-admin.sql en el proyecto Supabase.'
                : '';
            setMessage(`No pude cargar el módulo: ${error.message}.${migrationHint}`, 'error');
        } finally {
            state.loading = false;
            setBusy(false);
            render();
        }
    }

    function normalizeData(data) {
        if (!data || typeof data !== 'object') return emptyData();
        return {
            clientes: Array.isArray(data.clientes) ? data.clientes : [],
            ventas: Array.isArray(data.ventas) ? data.ventas : [],
            gastos: Array.isArray(data.gastos) ? data.gastos : [],
            cajas: Array.isArray(data.cajas) ? data.cajas : []
        };
    }

    function buildSavePayload(data) {
        return { data: normalizeData(data) };
    }

    async function saveData(nextData) {
        if (!state.loaded || state.revision === null) {
            throw new Error('No hay una copia comercial cargada desde Supabase.');
        }
        const result = await request('save', buildSavePayload(nextData), state.revision);
        if (result.conflict) {
            state.loaded = false;
            throw new Error('Los datos cambiaron en otro dispositivo. Actualiza el módulo antes de volver a guardar.');
        }
        state.data = normalizeData(result.data || nextData);
        state.revision = Number(result.revision);
        state.lastLoadedAt = new Date();
        render();
    }

    function activeCash() {
        return state.data.cajas.find(caja => caja.estado === 'abierta') || null;
    }

    function render() {
        if (!state.root?.querySelector('[data-business-page]')) return;
        state.root.querySelectorAll('[data-view]').forEach(button => {
            button.classList.toggle('active', button.dataset.view === state.activeView);
            button.setAttribute('aria-current', button.dataset.view === state.activeView ? 'page' : 'false');
        });
        const note = state.root.querySelector('[data-business-sync-note]');
        if (note) {
            note.textContent = state.loaded
                ? `Datos comerciales: Supabase · última carga ${state.lastLoadedAt?.toLocaleTimeString('es-MX') || 'ahora'} · revisión ${state.revision}.`
                : 'Conecta y carga la sincronización de Supabase para usar este módulo.';
        }
        const page = state.root.querySelector('[data-business-page]');
        page.innerHTML = state.loaded ? renderView() : `
            <section class="business-card business-empty">
                <h3>Conexión necesaria</h3>
                <p>Los registros comerciales se guardan aparte del inventario y requieren el espacio compartido de Supabase.</p>
                <button class="btn" type="button" data-action="refresh">Conectar y cargar</button>
            </section>`;
        renderMessage();
    }

    function renderView() {
        if (state.activeView === 'venta') return renderPOS();
        if (state.activeView === 'fiados') return renderDebts();
        if (state.activeView === 'clientes') return renderCustomers();
        if (state.activeView === 'gastos') return renderExpenses();
        return renderCash();
    }

    function renderPOS() {
        const products = root.NOVABusinessBridge?.getProducts() || [];
        const clients = state.data.clientes;
        const cartTotal = state.cart.reduce((total, item) => total + item.cantidad * item.precioUnitario, 0);
        const recentSales = state.data.ventas.slice().reverse().slice(0, 20);
        return `
            <div class="business-grid">
                <section class="business-card">
                    <h3>Agregar productos</h3>
                    ${products.length ? `
                        <form data-form="cart" class="business-form">
                            <label>Producto
                                <select name="productoId" required>
                                    <option value="">Selecciona un producto</option>
                                    ${products.map(product => `<option value="${escaparHTML(product.id)}">${escaparHTML(product.nombre)} · ${Number(product.cantidad) || 0} disponibles · ${dinero(product.precioVenta ?? product.precio)}</option>`).join('')}
                                </select>
                            </label>
                            <label>Cantidad<input name="cantidad" type="number" min="1" step="1" value="1" required></label>
                            <button class="btn" type="submit">Agregar al carrito</button>
                        </form>` : '<p>No hay productos cargados en el inventario.</p>'}
                </section>
                <section class="business-card">
                    <h3>Venta actual</h3>
                    ${state.cart.length ? `
                        <div class="business-table-wrap"><table class="business-table">
                            <thead><tr><th>Producto</th><th>Cant.</th><th>Precio</th><th>Total</th><th></th></tr></thead>
                            <tbody>${state.cart.map((item, index) => `<tr>
                                <td>${escaparHTML(item.nombre)}</td><td>${item.cantidad}</td>
                                <td>${dinero(item.precioUnitario)}</td><td>${dinero(item.cantidad * item.precioUnitario)}</td>
                                <td><button class="btn secondary" type="button" data-action="remove-cart" data-index="${index}" aria-label="Quitar ${escaparHTML(item.nombre)}">Quitar</button></td>
                            </tr>`).join('')}</tbody>
                        </table></div>
                        <form data-form="sale" class="business-form">
                            <label>Cliente
                                <select name="clienteId"><option value="">Venta sin cliente</option>
                                    ${clients.map(client => `<option value="${escaparHTML(client.id)}">${escaparHTML(client.nombre)}</option>`).join('')}
                                </select>
                            </label>
                            <label>Forma de pago
                                <select name="metodoPago"><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option><option value="transferencia">Transferencia</option><option value="fiado">Fiado</option></select>
                            </label>
                            <p class="business-total">Total: ${dinero(cartTotal)}</p>
                            <button class="btn" type="submit">Confirmar venta</button>
                        </form>
                    ` : '<p>Agrega productos para preparar una venta.</p>'}
                </section>
            </div>
            <section class="business-card business-recent-sales">
                <h3>Ventas recientes</h3>
                ${recentSales.length ? `<div class="business-table-wrap"><table class="business-table">
                    <thead><tr><th>Fecha</th><th>Cliente</th><th>Artículos</th><th>Total</th><th>Pago</th><th>Saldo</th></tr></thead>
                    <tbody>${recentSales.map(sale => {
                        const client = state.data.clientes.find(item => String(item.id) === String(sale.clienteId));
                        const itemSummary = (sale.items || []).map(item => `${item.cantidad} × ${item.nombre}`).join(', ');
                        return `<tr>
                            <td>${escaparHTML(sale.fecha)}</td>
                            <td>${escaparHTML(client?.nombre || 'Venta sin cliente')}</td>
                            <td>${escaparHTML(itemSummary)}</td>
                            <td>${dinero(sale.total)}</td>
                            <td>${escaparHTML(sale.metodoPago)}</td>
                            <td>${dinero(calcularSaldo(sale))}</td>
                        </tr>`;
                    }).join('')}</tbody></table></div>` : '<p>Aún no hay ventas registradas.</p>'}
            </section>
            <p class="business-footnote">La venta se confirma en Supabase y descuenta existencias del inventario en la misma operación. Las ventas a crédito requieren seleccionar un cliente.</p>`;
    }

    function renderDebts() {
        const outstanding = state.data.ventas.filter(sale => calcularSaldo(sale) > 0);
        return `<section class="business-card">
            <h3>Saldos pendientes</h3>
            ${outstanding.length ? `<div class="business-table-wrap"><table class="business-table">
                <thead><tr><th>Fecha</th><th>Cliente</th><th>Total</th><th>Saldo</th><th>Registrar pago</th></tr></thead>
                <tbody>${outstanding.map(sale => {
                    const client = state.data.clientes.find(item => String(item.id) === String(sale.clienteId));
                    return `<tr><td>${escaparHTML(sale.fecha)}</td><td>${escaparHTML(client?.nombre || 'Cliente no disponible')}</td>
                        <td>${dinero(sale.total)}</td><td>${dinero(calcularSaldo(sale))}</td>
                        <td><form data-form="payment" data-sale-id="${escaparHTML(sale.id)}" class="business-inline-form">
                            <input name="monto" type="number" min="0.01" max="${calcularSaldo(sale).toFixed(2)}" step="0.01" placeholder="Monto" required aria-label="Monto del abono">
                            <select name="metodo"><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option><option value="transferencia">Transferencia</option></select>
                            <button class="btn" type="submit">Abonar</button>
                        </form></td></tr>`;
                }).join('')}</tbody></table></div>` : '<p>No hay saldos pendientes registrados.</p>'}
        </section>`;
    }

    function renderCustomers() {
        return `<div class="business-grid">
            <section class="business-card"><h3>Nuevo cliente</h3>
                <form data-form="customer" class="business-form">
                    <label>Nombre<input name="nombre" maxlength="120" required></label>
                    <label>Teléfono<input name="telefono" type="tel" maxlength="40"></label>
                    <label>Nota<textarea name="nota" rows="3" maxlength="500"></textarea></label>
                    <button class="btn" type="submit">Guardar cliente</button>
                </form>
            </section>
            <section class="business-card"><h3>Clientes (${state.data.clientes.length})</h3>
                ${state.data.clientes.length ? `<div class="business-list">${state.data.clientes.map(client => `<article class="business-list-item">
                    <strong>${escaparHTML(client.nombre)}</strong><span>${escaparHTML(client.telefono || 'Sin teléfono')}</span>
                    ${client.nota ? `<p>${escaparHTML(client.nota)}</p>` : ''}
                </article>`).join('')}</div>` : '<p>Aún no hay clientes registrados.</p>'}
            </section>
        </div>`;
    }

    function renderExpenses() {
        return `<div class="business-grid">
            <section class="business-card"><h3>Registrar gasto</h3>
                <form data-form="expense" class="business-form">
                    <label>Descripción<input name="descripcion" maxlength="180" required></label>
                    <label>Categoría<input name="categoria" maxlength="80" placeholder="Renta, servicios, insumos…"></label>
                    <label>Monto<input name="monto" type="number" min="0.01" step="0.01" required></label>
                    <label>Fecha<input name="fecha" type="date" value="${fechaLocal()}" required></label>
                    <label>Pago
                        <select name="metodoPago"><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option><option value="transferencia">Transferencia</option></select>
                    </label>
                    <button class="btn" type="submit">Guardar gasto</button>
                </form>
            </section>
            <section class="business-card"><h3>Gastos recientes</h3>
                ${state.data.gastos.length ? `<div class="business-table-wrap"><table class="business-table">
                    <thead><tr><th>Fecha</th><th>Descripción</th><th>Categoría</th><th>Monto</th><th>Pago</th></tr></thead>
                    <tbody>${state.data.gastos.slice().reverse().slice(0, 30).map(expense => `<tr>
                        <td>${escaparHTML(expense.fecha)}</td><td>${escaparHTML(expense.descripcion)}</td>
                        <td>${escaparHTML(expense.categoria || '—')}</td><td>${dinero(expense.monto)}</td><td>${escaparHTML(expense.metodoPago)}</td>
                    </tr>`).join('')}</tbody></table></div>` : '<p>No hay gastos registrados.</p>'}
            </section>
        </div>`;
    }

    function renderCash() {
        const cash = activeCash();
        const closed = state.data.cajas.filter(item => item.estado === 'cerrada').slice().reverse().slice(0, 12);
        const summary = cash ? calcularCaja(state.data, cash) : null;
        return `<div class="business-grid">
            <section class="business-card">
                <h3>${cash ? 'Caja abierta' : 'Abrir caja'}</h3>
                ${cash ? `
                    <p>Abierta desde ${escaparHTML(cash.abiertaEn)}</p>
                    <dl class="business-summary">
                        <div><dt>Fondo inicial</dt><dd>${dinero(summary.fondoInicial)}</dd></div>
                        <div><dt>Ventas y abonos en efectivo</dt><dd>${dinero(summary.ventasEfectivo)}</dd></div>
                        <div><dt>Gastos en efectivo</dt><dd>− ${dinero(summary.gastosEfectivo)}</dd></div>
                        <div><dt>Efectivo esperado</dt><dd>${dinero(summary.esperado)}</dd></div>
                    </dl>
                    <form data-form="close-cash" class="business-form">
                        <label>Efectivo contado<input name="efectivoContado" type="number" min="0" step="0.01" required></label>
                        <button class="btn danger" type="submit">Cerrar caja</button>
                    </form>
                ` : `<form data-form="open-cash" class="business-form">
                    <label>Fondo inicial<input name="fondoInicial" type="number" min="0" step="0.01" value="0" required></label>
                    <button class="btn" type="submit">Abrir caja</button>
                </form>`}
            </section>
            <section class="business-card"><h3>Cierres recientes</h3>
                ${closed.length ? `<div class="business-list">${closed.map(item => `<article class="business-list-item">
                    <strong>${escaparHTML(item.abiertaEn)} — ${escaparHTML(item.cerradaEn)}</strong>
                    <span>Esperado ${dinero(item.efectivoEsperado)} · contado ${dinero(item.efectivoContado)} · diferencia ${dinero(item.diferencia)}</span>
                </article>`).join('')}</div>` : '<p>Aún no hay cierres registrados.</p>'}
            </section>
        </div>
        <p class="business-footnote">El efectivo esperado considera fondo inicial, cobros en efectivo y gastos en efectivo registrados durante la sesión.</p>`;
    }

    async function handleClick(event) {
        const viewButton = event.target.closest('[data-view]');
        if (viewButton && state.root.contains(viewButton)) {
            state.activeView = viewButton.dataset.view;
            render();
            return;
        }
        const button = event.target.closest('[data-action]');
        if (!button || !state.root.contains(button)) return;
        if (button.dataset.action === 'refresh') {
            await loadData();
        } else if (button.dataset.action === 'remove-cart') {
            state.cart.splice(Number(button.dataset.index), 1);
            render();
        }
    }

    async function handleChange(event) {
        if (event.target.name === 'metodoPago' && event.target.form?.dataset.form === 'sale') {
            const credit = event.target.value === 'fiado';
            const submit = event.target.form.querySelector('[type="submit"]');
            submit.textContent = credit ? 'Confirmar fiado' : 'Confirmar venta';
        }
    }

    async function handleSubmit(event) {
        const form = event.target.closest('form[data-form]');
        if (!form) return;
        event.preventDefault();
        if (state.busy) return;
        const values = Object.fromEntries(new FormData(form));
        try {
            setBusy(true);
            if (form.dataset.form === 'cart') await addCartItem(values);
            if (form.dataset.form === 'sale') await confirmSale(values);
            if (form.dataset.form === 'customer') await addCustomer(values);
            if (form.dataset.form === 'payment') await addPayment(form.dataset.saleId, values);
            if (form.dataset.form === 'expense') await addExpense(values);
            if (form.dataset.form === 'open-cash') await openCash(values);
            if (form.dataset.form === 'close-cash') await closeCash(values);
        } catch (error) {
            setMessage(error.message, 'error');
        } finally {
            setBusy(false);
        }
    }

    async function addCartItem(values) {
        const product = (root.NOVABusinessBridge?.getProducts() || [])
            .find(item => String(item.id) === String(values.productoId));
        const quantity = Number(values.cantidad);
        if (!product || !Number.isSafeInteger(quantity) || quantity < 1) {
            throw new Error('Selecciona un producto y una cantidad válida.');
        }
        const available = Number(product.cantidad) || 0;
        const existing = state.cart.find(item => String(item.productoId) === String(product.id));
        if (quantity + (existing?.cantidad || 0) > available) {
            throw new Error(`${product.nombre} tiene ${available} unidades disponibles; ajusta la cantidad del carrito.`);
        }
        const price = Number(product.precioVenta ?? product.precio);
        if (!Number.isFinite(price) || price < 0) throw new Error(`El precio de ${product.nombre} no es válido.`);
        if (existing) existing.cantidad += quantity;
        else state.cart.push({ productoId: product.id, nombre: product.nombre, cantidad: quantity, precioUnitario: price });
        setMessage('Producto agregado al carrito.', 'success');
        render();
    }

    async function confirmSale(values) {
        const bridge = root.NOVABusinessBridge;
        if (!bridge?.isInventoryReady()) {
            throw new Error('Sincroniza primero el inventario con Supabase y espera a que termine. La venta no se registró.');
        }
        if (!state.cart.length) throw new Error('Agrega al menos un producto a la venta.');
        if (values.metodoPago === 'fiado' && !values.clienteId) {
            throw new Error('Selecciona un cliente para registrar un fiado.');
        }
        const products = bridge.getProducts();
        const items = state.cart.map(item => {
            const product = products.find(candidate => String(candidate.id) === String(item.productoId));
            if (!product || Number(product.cantidad) < item.cantidad) {
                throw new Error(`Las existencias de ${item.nombre} cambiaron. Actualiza los datos antes de vender.`);
            }
            return {
                productoId: item.productoId,
                cantidad: item.cantidad,
                precioUnitario: item.precioUnitario
            };
        });
        const nextData = normalizeData(state.data);
        const sale = {
            id: crypto.randomUUID(),
            fecha: fechaLocal(),
            createdAt: new Date().toISOString(),
            clienteId: values.clienteId || null,
            metodoPago: values.metodoPago,
            items
        };
        const result = await request('sale', { data: nextData, sale }, state.revision);
        if (result.conflict) {
            state.loaded = false;
            throw new Error('El inventario o los datos comerciales cambiaron en otro dispositivo. Actualiza el módulo y vuelve a intentar.');
        }
        bridge.applyInventory(result.inventoryPayload, result.inventoryRevision);
        state.data = normalizeData(result.data);
        state.revision = Number(result.revision);
        state.inventoryRevision = Number(result.inventoryRevision);
        state.lastLoadedAt = new Date();
        state.cart = [];
        setMessage(`Venta ${result.sale?.id || sale.id} registrada. El inventario se actualizó en la misma operación.`, 'success');
        render();
    }

    async function addCustomer(values) {
        const nombre = String(values.nombre || '').trim();
        const telefono = String(values.telefono || '').trim();
        const phoneKey = normalizarTelefono(telefono);
        if (!nombre) throw new Error('Escribe el nombre del cliente.');
        if (phoneKey && state.data.clientes.some(client => normalizarTelefono(client.telefono) === phoneKey)) {
            throw new Error('Ya existe un cliente con ese teléfono. Selecciona el registro existente para no duplicarlo.');
        }
        const client = {
            id: crypto.randomUUID(),
            nombre,
            telefono,
            nota: String(values.nota || '').trim(),
            createdAt: new Date().toISOString()
        };
        await saveData({ ...state.data, clientes: [...state.data.clientes, client] });
        setMessage('Cliente guardado.', 'success');
    }

    async function addPayment(saleId, values) {
        const amount = Number(values.monto);
        const saleIndex = state.data.ventas.findIndex(item => String(item.id) === String(saleId));
        if (saleIndex < 0 || !Number.isFinite(amount) || amount <= 0) throw new Error('El pago o la venta no son válidos.');
        const sale = state.data.ventas[saleIndex];
        if (amount > calcularSaldo(sale)) throw new Error(`El abono supera el saldo pendiente de ${dinero(calcularSaldo(sale))}.`);
        const sales = state.data.ventas.slice();
        const payments = Array.isArray(sale.pagos) ? sale.pagos.slice() : [];
        payments.push({ id: crypto.randomUUID(), monto: amount, metodo: values.metodo, fecha: new Date().toISOString() });
        sales[saleIndex] = { ...sale, pagos: payments, saldo: calcularSaldo({ ...sale, pagos: payments }) };
        await saveData({ ...state.data, ventas: sales });
        setMessage('Abono registrado y saldo actualizado.', 'success');
    }

    async function addExpense(values) {
        const amount = Number(values.monto);
        if (!Number.isFinite(amount) || amount <= 0 || !values.descripcion || !values.fecha) {
            throw new Error('Completa una descripción, fecha y monto válido para el gasto.');
        }
        const expense = {
            id: crypto.randomUUID(),
            descripcion: String(values.descripcion).trim(),
            categoria: String(values.categoria || '').trim(),
            monto: Number(amount.toFixed(2)),
            fecha: values.fecha,
            metodoPago: values.metodoPago,
            createdAt: new Date().toISOString()
        };
        await saveData({ ...state.data, gastos: [...state.data.gastos, expense] });
        setMessage('Gasto guardado.', 'success');
    }

    async function openCash(values) {
        if (activeCash()) throw new Error('Ya hay una caja abierta.');
        const amount = Number(values.fondoInicial);
        if (!Number.isFinite(amount) || amount < 0) throw new Error('Indica un fondo inicial válido.');
        const cash = {
            id: crypto.randomUUID(),
            estado: 'abierta',
            fondoInicial: Number(amount.toFixed(2)),
            abiertaEn: new Date().toISOString()
        };
        await saveData({ ...state.data, cajas: [...state.data.cajas, cash] });
        setMessage('Caja abierta.', 'success');
    }

    async function closeCash(values) {
        const cash = activeCash();
        const counted = Number(values.efectivoContado);
        if (!cash || !Number.isFinite(counted) || counted < 0) throw new Error('Indica el efectivo contado para la caja abierta.');
        const summary = calcularCaja(state.data, cash);
        const closedAt = new Date().toISOString();
        const cajas = state.data.cajas.map(item => String(item.id) === String(cash.id)
            ? {
                ...item,
                estado: 'cerrada',
                cerradaEn: closedAt,
                efectivoContado: Number(counted.toFixed(2)),
                efectivoEsperado: summary.esperado,
                diferencia: Number((counted - summary.esperado).toFixed(2))
            }
            : item);
        await saveData({ ...state.data, cajas });
        setMessage(`Caja cerrada. Diferencia: ${dinero(counted - summary.esperado)}.`, 'success');
    }

    function resumenParaNOVA() {
        if (!state.loaded) {
            return {
                mensaje: 'No tengo una conexión cargada con los datos de Administración del negocio. Abre esa sección para consultar Supabase.'
            };
        }
        const month = fechaLocal().slice(0, 7);
        const sales = state.data.ventas.filter(sale => String(sale.fecha || '').startsWith(month));
        const expenses = state.data.gastos.filter(expense => String(expense.fecha || '').startsWith(month));
        const salesTotal = sales.reduce((sum, sale) => sum + (Number(sale.total) || 0), 0);
        const pending = state.data.ventas.reduce((sum, sale) => sum + calcularSaldo(sale), 0);
        const expensesTotal = expenses.reduce((sum, expense) => sum + (Number(expense.monto) || 0), 0);
        const cash = activeCash();
        const clientCountLabel = `${state.data.clientes.length} cliente${state.data.clientes.length === 1 ? '' : 's'}`;
        return {
            texto: `Administración del negocio (datos cargados desde Supabase, revisión ${state.revision}): ${state.data.ventas.length} ventas registradas, ${dinero(salesTotal)} en ventas este mes, ${clientCountLabel}, saldo pendiente de fiados ${dinero(pending)}, gastos de este mes ${dinero(expensesTotal)} y ${cash ? 'una caja abierta' : 'ninguna caja abierta'}.`,
            revision: state.revision
        };
    }

    function respuestaConsultaNOVA(pregunta) {
        const resumen = resumenParaNOVA();
        if (!state.loaded) return resumen.mensaje;
        const normalized = String(pregunta || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const source = `Datos comerciales cargados desde Supabase (revisión ${state.revision}).`;
        if (/\b(clientes?|quienes compran)\b/.test(normalized)) {
            const names = state.data.clientes.slice(0, 10).map(client => client.nombre);
            return `${source} Hay ${state.data.clientes.length} clientes registrados${names.length ? `: ${names.join(', ')}${state.data.clientes.length > names.length ? ' y otros' : ''}` : '.'}`;
        }
        if (/\b(fiados?|deudas?|deben|pendientes|saldos?)\b/.test(normalized)) {
            const debts = state.data.ventas.filter(sale => calcularSaldo(sale) > 0);
            const total = debts.reduce((sum, sale) => sum + calcularSaldo(sale), 0);
            const details = debts.slice(0, 8).map(sale => {
                const client = state.data.clientes.find(item => String(item.id) === String(sale.clienteId));
                return `${client?.nombre || 'Cliente sin nombre'}: ${dinero(calcularSaldo(sale))}`;
            });
            return `${source} Hay ${debts.length} fiados con saldo pendiente por ${dinero(total)}${details.length ? `. Detalle: ${details.join('; ')}${debts.length > details.length ? '; y otros' : ''}.` : '.'}`;
        }
        if (/\b(gastos?|egresos?)\b/.test(normalized)) {
            const month = fechaLocal().slice(0, 7);
            const expenses = state.data.gastos.filter(expense => String(expense.fecha || '').startsWith(month));
            const total = expenses.reduce((sum, expense) => sum + (Number(expense.monto) || 0), 0);
            return `${source} Este mes hay ${expenses.length} gastos registrados por ${dinero(total)}.`;
        }
        if (/\b(caja|efectivo|cierre)\b/.test(normalized)) {
            const cash = activeCash();
            if (!cash) return `${source} No hay una caja abierta actualmente.`;
            const totals = calcularCaja(state.data, cash);
            return `${source} La caja está abierta. Efectivo esperado: ${dinero(totals.esperado)} (fondo ${dinero(totals.fondoInicial)}, entradas en efectivo ${dinero(totals.ventasEfectivo)} y gastos en efectivo ${dinero(totals.gastosEfectivo)}).`;
        }
        return resumen.texto;
    }

    function activate() {
        state.root = state.root || document.getElementById('businessAdminApp');
        if (!state.root) return;
        ensureShell();
        if (!state.loaded) void loadData();
        else render();
    }

    return {
        activate,
        buildSavePayload,
        calcularCaja,
        calcularSaldo,
        normalizarTelefono,
        respuestaConsultaNOVA,
        resumenParaNOVA
    };
});
