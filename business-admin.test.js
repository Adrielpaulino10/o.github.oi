const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildSavePayload,
    calcularCaja,
    calcularSaldo,
    normalizarTelefono
} = require('./business-admin.js');

test('envuelve los datos comerciales con la forma que valida manage_business_store', () => {
    const data = {
        clientes: [{ id: 'customer-1', nombre: 'Ana' }],
        ventas: [],
        gastos: [],
        cajas: []
    };

    assert.deepEqual(buildSavePayload(data), { data });
});

test('calcula el saldo de un fiado después de varios abonos', () => {
    const saldo = calcularSaldo({
        total: 120,
        pagos: [{ monto: 25 }, { monto: 15 }]
    });

    assert.equal(saldo, 80);
});

test('calcula el efectivo esperado solo con movimientos en efectivo de la sesión', () => {
    const ahora = new Date('2026-11-05T19:00:00.000Z');
    const resumen = calcularCaja({
        ventas: [
            { pagos: [
                { monto: 50, metodo: 'efectivo', fecha: '2026-11-05T16:00:00.000Z' },
                { monto: 20, metodo: 'tarjeta', fecha: '2026-11-05T16:30:00.000Z' },
                { monto: 10, metodo: 'efectivo', fecha: '2026-11-05T10:00:00.000Z' }
            ] }
        ],
        gastos: [
            { monto: 8, metodoPago: 'efectivo', createdAt: '2026-11-05T17:00:00.000Z' },
            { monto: 4, metodoPago: 'transferencia', createdAt: '2026-11-05T17:30:00.000Z' }
        ]
    }, { abiertaEn: '2026-11-05T12:00:00.000Z', fondoInicial: 100 }, ahora);

    assert.deepEqual(resumen, {
        fondoInicial: 100,
        ventasEfectivo: 50,
        gastosEfectivo: 8,
        esperado: 142,
        contado: 0,
        diferencia: -142
    });
});

test('normaliza teléfonos para detectar clientes duplicados', () => {
    assert.equal(normalizarTelefono('+52 (55) 1234-5678'), '525512345678');
    assert.equal(normalizarTelefono(''), '');
});

test('no registra como pendiente un saldo negativo por pagos excedentes', () => {
    assert.equal(calcularSaldo({ total: 25, pagos: [{ monto: 30 }] }), 0);
});

test('ignora movimientos en efectivo anteriores a la apertura de caja', () => {
    const resumen = calcularCaja({
        ventas: [{ pagos: [
            { monto: 100, metodo: 'efectivo', fecha: '2026-11-05T08:00:00.000Z' }
        ] }],
        gastos: []
    }, { abiertaEn: '2026-11-05T12:00:00.000Z', fondoInicial: 20 },
    new Date('2026-11-05T19:00:00.000Z'));

    assert.equal(resumen.esperado, 20);
});
