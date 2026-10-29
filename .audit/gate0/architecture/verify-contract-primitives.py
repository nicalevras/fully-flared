from pathlib import Path
import hashlib
import json
import sqlite3

root = Path('/tmp/fully-flared-gate0-baseline')
db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
for migration in sorted((root / 'web/migrations').glob('*.sql')):
    db.executescript(migration.read_text())
db.execute("INSERT INTO products(id,slug,title,created_at,updated_at) VALUES('p','p','Original','now','now')")
db.execute("INSERT INTO variants(id,product_id,sku,title,price_cents,created_at) VALUES('v','p','SKU-1','Default',1000,'now')")
db.execute("INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES('SKU-1',10,0,'now')")
db.commit()
results = []

def revision():
    return db.execute("SELECT target_revision FROM catalog_work WHERE id='product:p'").fetchone()[0]

def save(expected, title):
    with db:
        db.execute("INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM products WHERE id='p') OR COALESCE((SELECT target_revision FROM catalog_work WHERE id='product:p'),0)<>?", (expected,))
        db.execute("UPDATE products SET title=? WHERE id='p'", (title,))

base = revision()
save(base, 'Writer A')
try:
    save(base, 'Writer B')
    raise AssertionError('stale revision was accepted')
except sqlite3.IntegrityError:
    assert db.execute("SELECT title FROM products WHERE id='p'").fetchone()[0] == 'Writer A'
results.append({'case': 'same-base-revision second save rejected', 'pass': True})
base = revision()
with db:
    db.execute("UPDATE variants SET title='Changed variant' WHERE id='v'")
assert revision() > base
results.append({'case': 'child variant advances product token', 'pass': True})

def adjust(operation, delta, sku='SKU-1', reason='correction'):
    identity = hashlib.sha256(json.dumps(['actor', operation, sku]).encode()).hexdigest()
    payload = hashlib.sha256(json.dumps({'sku': sku, 'delta': delta, 'reason': reason}, sort_keys=True).encode()).hexdigest()
    with db:
        db.execute('INSERT INTO batch_guard SELECT 1 WHERE EXISTS(SELECT 1 FROM stock_ledger WHERE id=? AND (sku<>? OR delta_on_hand<>? OR reason<>? OR ref_type<>\'admin-operation\' OR ref_id<>?))', (identity, sku, delta, reason, payload))
        db.execute("INSERT INTO stock_ledger(id,sku,delta_on_hand,reason,ref_type,ref_id,created_at) SELECT ?,?,?,?,'admin-operation',?,'now' WHERE NOT EXISTS(SELECT 1 FROM stock_ledger WHERE id=?)", (identity, sku, delta, reason, payload, identity))
        inserted = db.execute('SELECT changes()').fetchone()[0]
        db.execute("UPDATE stock SET on_hand=on_hand+?,updated_at='now' WHERE sku=? AND changes()>0", (delta, sku))
        db.execute('INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM stock WHERE sku=?)', (sku,))
    return bool(inserted)

assert adjust('op-1', 5)
assert not adjust('op-1', 5)
assert db.execute("SELECT on_hand FROM stock WHERE sku='SKU-1'").fetchone()[0] == 15
results.append({'case': 'same operation replay applies delta once', 'pass': True})
try:
    adjust('op-1', 6)
    raise AssertionError('changed payload was accepted')
except sqlite3.IntegrityError:
    assert db.execute("SELECT on_hand FROM stock WHERE sku='SKU-1'").fetchone()[0] == 15
results.append({'case': 'same operation changed payload rejected', 'pass': True})
try:
    adjust('op-2', -100)
    raise AssertionError('negative stock accepted')
except sqlite3.IntegrityError:
    assert db.execute("SELECT on_hand FROM stock WHERE sku='SKU-1'").fetchone()[0] == 15
results.append({'case': 'stock guard rolls back ledger receipt and stock', 'pass': True})
assert db.execute("SELECT COUNT(*) FROM stock_ledger WHERE ref_type='admin-operation'").fetchone()[0] == 1
output = {'verdict': 'PASS', 'surface': 'in-memory Python SQLite against unmodified main migrations; not D1 or server-action verification', 'cases': results, 'limitations': ['No network or concurrent D1 calls', 'Audit insertion and permission wiring are not implemented by this primitive proof', 'No set-count, note field, partial-failure API or publisher status implementation']}
Path('.audit/gate0/architecture/contract-primitives-results.json').write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps(output, indent=2))
