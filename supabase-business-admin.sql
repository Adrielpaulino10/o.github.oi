-- Additive setup for the independent NOVA business-administration module.
-- Run supabase.sql first, then run this file in the Supabase SQL Editor.
-- It adds a separate commercial payload and an RPC; it does not alter or
-- remove existing inventory tables, records, or functions.

CREATE TABLE IF NOT EXISTS public.tienda_business_stores (
    code_hash bytea PRIMARY KEY,
    payload jsonb NOT NULL DEFAULT '{"clientes":[],"ventas":[],"gastos":[],"cajas":[]}'::jsonb,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(payload) = 'object')
);

ALTER TABLE public.tienda_business_stores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tienda_business_stores FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.manage_business_store(
    p_code text,
    p_action text,
    p_data jsonb DEFAULT NULL,
    p_expected_revision bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
    v_hash bytea;
    v_inventory public.tienda_sync_stores%ROWTYPE;
    v_business public.tienda_business_stores%ROWTYPE;
    v_data jsonb;
    v_sale jsonb;
    v_saved_sale jsonb;
    v_item jsonb;
    v_product jsonb;
    v_products jsonb;
    v_transactions jsonb;
    v_inventory_payload jsonb;
    v_items jsonb := '[]'::jsonb;
    v_payments jsonb := '[]'::jsonb;
    v_product_id text;
    v_sale_id text;
    v_payment_method text;
    v_quantity integer;
    v_stock integer;
    v_price numeric;
    v_cost numeric;
    v_line_total numeric;
    v_total numeric := 0;
    v_balance numeric;
    v_business_revision bigint;
    v_inventory_revision bigint;
    v_now timestamptz := now();
BEGIN
    IF p_code IS NULL OR char_length(p_code) < 5 OR char_length(p_code) > 128 THEN
        RAISE EXCEPTION 'Invalid shared code' USING ERRCODE = '22023';
    END IF;
    IF p_action IS NULL OR p_action NOT IN ('read', 'save', 'sale') THEN
        RAISE EXCEPTION 'Invalid business action' USING ERRCODE = '22023';
    END IF;

    v_hash := extensions.digest(convert_to(p_code, 'UTF8'), 'sha256');

    -- Lock the existing shared inventory record first so a sale and inventory
    -- update commit atomically and cannot oversell across devices.
    SELECT * INTO v_inventory
    FROM public.tienda_sync_stores
    WHERE code_hash = v_hash
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Shared inventory store not found; connect inventory first' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO public.tienda_business_stores (code_hash)
    VALUES (v_hash)
    ON CONFLICT (code_hash) DO NOTHING;

    SELECT * INTO v_business
    FROM public.tienda_business_stores
    WHERE code_hash = v_hash
    FOR UPDATE;

    IF p_action = 'read' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'data', v_business.payload,
            'revision', v_business.revision,
            'inventoryRevision', v_inventory.revision
        );
    END IF;

    IF p_expected_revision IS NULL OR p_expected_revision <> v_business.revision THEN
        RETURN jsonb_build_object('ok', true, 'conflict', true);
    END IF;

    IF p_data IS NULL OR jsonb_typeof(p_data->'data') IS DISTINCT FROM 'object'
        OR jsonb_typeof(p_data->'data'->'clientes') IS DISTINCT FROM 'array'
        OR jsonb_typeof(p_data->'data'->'ventas') IS DISTINCT FROM 'array'
        OR jsonb_typeof(p_data->'data'->'gastos') IS DISTINCT FROM 'array'
        OR jsonb_typeof(p_data->'data'->'cajas') IS DISTINCT FROM 'array'
        OR pg_column_size(p_data) > 1048576 THEN
        RAISE EXCEPTION 'Invalid business payload' USING ERRCODE = '22023';
    END IF;
    v_data := p_data->'data';

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_data->'clientes') AS entry(value)
        WHERE jsonb_typeof(value) <> 'object'
            OR nullif(btrim(value->>'id'), '') IS NULL
            OR nullif(btrim(value->>'nombre'), '') IS NULL
    ) OR EXISTS (
        SELECT value->>'id' FROM jsonb_array_elements(v_data->'clientes') AS entry(value)
        GROUP BY value->>'id' HAVING count(*) > 1
    ) OR EXISTS (
        SELECT nullif(regexp_replace(coalesce(value->>'telefono', ''), '[^0-9]', '', 'g'), '')
        FROM jsonb_array_elements(v_data->'clientes') AS entry(value)
        WHERE nullif(regexp_replace(coalesce(value->>'telefono', ''), '[^0-9]', '', 'g'), '') IS NOT NULL
        GROUP BY nullif(regexp_replace(coalesce(value->>'telefono', ''), '[^0-9]', '', 'g'), '')
        HAVING count(*) > 1
    ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_data->'ventas') AS entry(value)
        WHERE jsonb_typeof(value) <> 'object' OR nullif(btrim(value->>'id'), '') IS NULL
    ) OR EXISTS (
        SELECT value->>'id' FROM jsonb_array_elements(v_data->'ventas') AS entry(value)
        GROUP BY value->>'id' HAVING count(*) > 1
    ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_data->'gastos') AS entry(value)
        WHERE jsonb_typeof(value) <> 'object' OR nullif(btrim(value->>'id'), '') IS NULL
    ) OR EXISTS (
        SELECT value->>'id' FROM jsonb_array_elements(v_data->'gastos') AS entry(value)
        GROUP BY value->>'id' HAVING count(*) > 1
    ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_data->'cajas') AS entry(value)
        WHERE jsonb_typeof(value) <> 'object' OR nullif(btrim(value->>'id'), '') IS NULL
    ) OR EXISTS (
        SELECT value->>'id' FROM jsonb_array_elements(v_data->'cajas') AS entry(value)
        GROUP BY value->>'id' HAVING count(*) > 1
    ) OR (
        SELECT count(*) FROM jsonb_array_elements(v_data->'cajas') AS entry(value)
        WHERE value->>'estado' = 'abierta'
    ) > 1 THEN
        RAISE EXCEPTION 'Business records contain duplicate or missing identifiers' USING ERRCODE = '22023';
    END IF;

    IF p_action = 'save' THEN
        UPDATE public.tienda_business_stores
        SET payload = v_data,
            revision = revision + 1,
            updated_at = v_now
        WHERE code_hash = v_hash
        RETURNING revision INTO v_business_revision;
        RETURN jsonb_build_object(
            'ok', true,
            'conflict', false,
            'data', v_data,
            'revision', v_business_revision
        );
    END IF;

    v_sale := p_data->'sale';
    IF jsonb_typeof(v_sale) IS DISTINCT FROM 'object'
        OR nullif(btrim(v_sale->>'id'), '') IS NULL
        OR jsonb_typeof(v_sale->'items') IS DISTINCT FROM 'array'
        OR jsonb_array_length(v_sale->'items') < 1
        OR jsonb_array_length(v_sale->'items') > 100 THEN
        RAISE EXCEPTION 'Invalid sale' USING ERRCODE = '22023';
    END IF;
    v_sale_id := v_sale->>'id';
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_data->'ventas') AS entry(value)
        WHERE value->>'id' = v_sale_id
    ) THEN
        RAISE EXCEPTION 'Sale identifier already exists' USING ERRCODE = '22023';
    END IF;

    v_payment_method := v_sale->>'metodoPago';
    IF v_payment_method NOT IN ('efectivo', 'tarjeta', 'transferencia', 'fiado') THEN
        RAISE EXCEPTION 'Invalid payment method' USING ERRCODE = '22023';
    END IF;
    IF v_payment_method = 'fiado'
        AND (v_sale->>'clienteId' IS NULL OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_data->'clientes') AS entry(value)
            WHERE value->>'id' = v_sale->>'clienteId'
        )) THEN
        RAISE EXCEPTION 'A credit sale requires an existing customer' USING ERRCODE = '22023';
    END IF;
    IF coalesce(v_sale->>'fecha', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'Invalid sale date' USING ERRCODE = '22023';
    END IF;

    v_products := v_inventory.payload->'productos';
    v_transactions := v_inventory.payload->'transacciones';
    IF jsonb_typeof(v_products) IS DISTINCT FROM 'array'
        OR jsonb_typeof(v_transactions) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Shared inventory payload is invalid' USING ERRCODE = '22023';
    END IF;

    FOR v_item IN SELECT value FROM jsonb_array_elements(v_sale->'items')
    LOOP
        IF jsonb_typeof(v_item) <> 'object'
            OR nullif(btrim(v_item->>'productoId'), '') IS NULL
            OR jsonb_typeof(v_item->'cantidad') IS DISTINCT FROM 'number'
            OR jsonb_typeof(v_item->'precioUnitario') IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'Invalid sale item' USING ERRCODE = '22023';
        END IF;
        v_product_id := v_item->>'productoId';
        v_quantity := (v_item->>'cantidad')::integer;
        v_price := (v_item->>'precioUnitario')::numeric;
        IF v_quantity <= 0 OR trunc((v_item->>'cantidad')::numeric) <> v_quantity
            OR v_price < 0 OR v_price > 1000000000 THEN
            RAISE EXCEPTION 'Invalid sale quantity or price' USING ERRCODE = '22023';
        END IF;
        IF (SELECT count(*) FROM jsonb_array_elements(v_products) AS entry(value)
            WHERE value->>'id' = v_product_id) <> 1 THEN
            RAISE EXCEPTION 'Product is missing or duplicated in inventory' USING ERRCODE = '22023';
        END IF;
        IF EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v_sale->'items') AS entry(value)
            WHERE value->>'productoId' = v_product_id
            GROUP BY value->>'productoId'
            HAVING count(*) > 1
        ) THEN
            RAISE EXCEPTION 'A product may appear only once in a sale' USING ERRCODE = '22023';
        END IF;
        SELECT value INTO v_product
        FROM jsonb_array_elements(v_products) AS entry(value)
        WHERE value->>'id' = v_product_id;
        v_stock := (v_product->>'cantidad')::integer;
        v_cost := coalesce(nullif(v_product->>'costo', '')::numeric, 0);
        IF v_stock < v_quantity THEN
            RAISE EXCEPTION 'Insufficient stock for product %', v_product->>'nombre' USING ERRCODE = '22023';
        END IF;
        IF v_price <> coalesce(nullif(v_product->>'precioVenta', '')::numeric,
            nullif(v_product->>'precio', '')::numeric, 0) THEN
            RAISE EXCEPTION 'Sale price differs from the current product price' USING ERRCODE = '22023';
        END IF;

        v_line_total := round(v_price * v_quantity, 2);
        v_total := v_total + v_line_total;
        v_items := v_items || jsonb_build_array(jsonb_build_object(
            'productoId', v_product_id,
            'nombre', v_product->>'nombre',
            'cantidad', v_quantity,
            'precioUnitario', v_price,
            'costoUnitario', v_cost,
            'total', v_line_total
        ));
        v_transactions := v_transactions || jsonb_build_array(jsonb_build_object(
            'id', gen_random_uuid()::text,
            'fecha', v_sale->>'fecha',
            'tipo', 'venta',
            'monto', v_line_total,
            'costoProductos', round(v_cost * v_quantity, 2),
            'cantidadVendida', v_quantity,
            'productoId', v_product_id,
            'saleId', v_sale_id,
            'descripcion', 'Venta de ' || v_quantity || ' x ' || coalesce(v_product->>'nombre', 'producto'),
            'updatedAt', v_now
        ));
    END LOOP;

    IF v_payment_method = 'fiado' THEN
        v_balance := v_total;
    ELSE
        v_balance := 0;
        v_payments := jsonb_build_array(jsonb_build_object(
            'id', gen_random_uuid()::text,
            'monto', v_total,
            'metodo', v_payment_method,
            'fecha', v_now
        ));
    END IF;

    v_saved_sale := jsonb_build_object(
        'id', v_sale_id,
        'fecha', v_sale->>'fecha',
        'createdAt', v_now,
        'clienteId', nullif(v_sale->>'clienteId', ''),
        'metodoPago', v_payment_method,
        'items', v_items,
        'total', round(v_total, 2),
        'saldo', round(v_balance, 2),
        'pagos', v_payments
    );
    v_data := jsonb_set(v_data, '{ventas}', (v_data->'ventas') || jsonb_build_array(v_saved_sale));
    IF pg_column_size(v_data) > 1048576 THEN
        RAISE EXCEPTION 'Business data limit exceeded' USING ERRCODE = '22023';
    END IF;

    SELECT jsonb_agg(
        CASE WHEN product.value->>'id' = item.value->>'productoId'
            THEN jsonb_set(
                jsonb_set(product.value, '{cantidad}',
                    to_jsonb((product.value->>'cantidad')::integer - (item.value->>'cantidad')::integer), false),
                '{updatedAt}', to_jsonb(v_now::text), true
            )
            ELSE product.value
        END
        ORDER BY product.ordinality
    )
    INTO v_products
    FROM jsonb_array_elements(v_inventory.payload->'productos') WITH ORDINALITY AS product(value, ordinality)
    LEFT JOIN LATERAL (
        SELECT value FROM jsonb_array_elements(v_sale->'items') AS sale_item(value)
        WHERE value->>'productoId' = product.value->>'id'
    ) AS item ON true;

    v_inventory_payload := jsonb_set(
            jsonb_set(v_inventory.payload, '{productos}', coalesce(v_products, '[]'::jsonb)),
            '{transacciones}', v_transactions
        ) || jsonb_build_object('updatedAt', v_now);
    IF pg_column_size(v_inventory_payload) > 1048576 THEN
        RAISE EXCEPTION 'Inventory data limit exceeded' USING ERRCODE = '22023';
    END IF;

    UPDATE public.tienda_sync_stores
    SET payload = v_inventory_payload,
        revision = revision + 1,
        updated_at = v_now
    WHERE code_hash = v_hash
    RETURNING revision INTO v_inventory_revision;

    UPDATE public.tienda_business_stores
    SET payload = v_data,
        revision = revision + 1,
        updated_at = v_now
    WHERE code_hash = v_hash
    RETURNING revision INTO v_business_revision;

    RETURN jsonb_build_object(
        'ok', true,
        'conflict', false,
        'data', v_data,
        'sale', v_saved_sale,
        'revision', v_business_revision,
        'inventoryRevision', v_inventory_revision,
        'inventoryPayload', v_inventory_payload
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.manage_business_store(text, text, jsonb, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manage_business_store(text, text, jsonb, bigint) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
