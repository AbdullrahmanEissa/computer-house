import CheckoutForm from '@/components/CheckoutForm';

export default function HomePage() {
  const demoItems = [
    {
      product_id: 'a7b40000-0000-41d4-a716-446655440002',
      quantity: 1,
      unit_price: 450,
    },
  ];

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center p-6 md:p-12">
      <div className="max-w-4xl w-full space-y-8">
        <header className="border-b border-zinc-800 pb-6 text-center">
          <h1 className="text-4xl font-extrabold tracking-tight text-violet-400">
            Computer House Storefront
          </h1>
          <p className="text-zinc-400 mt-2">High-performance custom PCs & hardware components</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
          <section className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-xl">
            <h2 className="text-xl font-bold mb-4 text-zinc-200">Selected Item</h2>
            <div className="space-y-3">
              <div className="flex justify-between text-sm py-2 border-b border-zinc-800">
                <span className="text-zinc-300">Catalog Hardware Component</span>
                <span className="font-semibold text-violet-400">450.00 EGP</span>
              </div>
              <div className="flex justify-between text-base font-bold pt-2">
                <span>Total</span>
                <span className="text-violet-400">450.00 EGP</span>
              </div>
            </div>
          </section>

          <section className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-xl">
            <h2 className="text-xl font-bold mb-4 text-zinc-200">Checkout</h2>
            <CheckoutForm customerId="550e8400-e29b-41d4-a716-446655440000" items={demoItems} />
          </section>
        </div>
      </div>
    </main>
  );
}
