import { notFound } from 'next/navigation';
import { getProduct } from '@/lib/api';
import CheckoutForm from '@/components/CheckoutForm';

type Props = { params: Promise<{ slug: string }> };

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const product = await getProduct(slug);

  if (!product) {
    notFound();
  }

  const orderItems = [
    {
      product_id: product.id,
      quantity: 1,
      unit_price: product.price,
    },
  ];

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8 flex justify-center">
      <div className="max-w-2xl w-full space-y-6">
        <h1 className="text-3xl font-bold">{product.name}</h1>
        <p className="text-zinc-400">{product.description}</p>
        <p className="text-xl font-semibold text-violet-400">{product.price} EGP</p>
        <div className="border-t border-zinc-800 pt-6">
          <CheckoutForm customerId="guest-customer-001" items={orderItems} />
        </div>
      </div>
    </main>
  );
}
