import {
  ArrowRight,
  BadgeCheck,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  CircleUserRound,
  ClipboardList,
  Code2,
  Crown,
  Database,
  Download,
  Edit3,
  FileUp,
  Gamepad2,
  Headphones,
  Heart,
  Instagram,
  Laptop,
  LockKeyhole,
  LogOut,
  Mail,
  Menu,
  MonitorCog,
  PackageCheck,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Star,
  Trash2,
  Upload,
  UserCog,
  UserRound,
  UsersRound,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { PROJECT_IDENTITY } from "./projectIdentity";

type Category = "juego" | "software" | "servicio";
type Filter = "todos" | Category;
type View = "inicio" | "catalogo" | "servicios" | "como-funciona" | "administracion";
// "invitado" es el visitante sin sesion: no existe fila en profiles.
type UserRole = "superadmin" | "admin" | "usuario" | "invitado";
type AdminTab = "resumen" | "usuarios" | "publicaciones" | "citas" | "pedidos";

interface Listing {
  id: number;
  slug: string;
  title: string;
  description: string;
  category: Category;
  priceCents: number;
  publisher: string;
  coverKey: string;
  featured: boolean;
  hasExecutable: boolean;
  downloadFilename?: string | null;
  downloadSize?: number | null;
  createdAt: string;
}

interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active?: boolean;
}

interface AuthSession {
  user: AuthUser;
  token: string;
  refreshToken: string;
  expiresAt: string;
}

interface CartLine {
  listingId: number;
  title: string;
  category: Category;
  priceCents: number;
  publisher: string;
  coverKey: string;
  quantity: number;
}

interface CartData {
  items: CartLine[];
  count: number;
  totalCents: number;
  error?: string;
}

interface AdminSummary {
  users: number;
  admins: number;
  listings: number;
  bookings: number;
  pendingBookings: number;
  orders: number;
  salesCents: number;
}

interface AdminUser extends AuthUser {
  active: boolean;
  createdAt: string;
}

interface AdminListing extends Listing {
  published: boolean;
  ownerUserId: string | null;
}

interface AdminBooking {
  id: number;
  customerName: string;
  customerEmail: string;
  scheduledDate: string;
  notes: string;
  status: string;
  listingTitle: string;
}

interface AdminOrder {
  id: number;
  totalCents: number;
  status: string;
  createdAt: string;
  customerName: string;
  customerEmail: string;
}

const covers: Record<string, string> = {
  andes: "/assets/cover-andes-v2.png",
  forge: "/assets/cover-forge-v2.png",
  preventivo: "/assets/cover-preventivo-v2.png",
  focus: "/assets/cover-focus-v2.png",
  orbit: "/assets/cover-orbit-v2.png",
  network: "/assets/cover-network-v2.png",
};

const categoryCopy = {
  juego: { label: "Juego", plural: "Juegos", icon: Gamepad2, tone: "violet" },
  software: { label: "Software", plural: "Software", icon: Code2, tone: "cyan" },
  servicio: { label: "Servicio", plural: "Soporte técnico", icon: Headphones, tone: "lime" },
} as const;

const currency = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

const distributionKind = (filename?: string | null) => {
  const extension = filename?.split(".").pop()?.trim().toUpperCase();
  return extension ? `Archivo ${extension}` : "Archivo del proyecto";
};

const fileSize = (bytes?: number | null) => {
  if (!bytes) return "listo para descargar";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

function Brand({ onClick }: { onClick: () => void }) {
  return <button className="brand" type="button" onClick={onClick} aria-label="Ir al inicio de TAKANA"><span className="brand-mascot"><img src="/assets/takana-mascot.png" alt="" /></span><strong>TAKANA</strong></button>;
}

function ProductCard({ item, favorite, onFavorite, onOpen, onCart }: {
  item: Listing;
  favorite: boolean;
  onFavorite: () => void;
  onOpen: () => void;
  onCart: () => void;
}) {
  const meta = categoryCopy[item.category];
  return (
    <article className="product-card">
      <button className="product-cover" type="button" onClick={onOpen} aria-label={`Ver ${item.title}`}>
        <img src={covers[item.coverKey] || covers.orbit} alt="" />
        <span className={`product-badge badge-${meta.tone}`}>{item.featured ? "Destacado" : meta.label}</span>
      </button>
      <button className={`favorite ${favorite ? "active" : ""}`} type="button" onClick={onFavorite} aria-label="Agregar a favoritos"><Heart /></button>
      <div className="product-body">
        <button className="product-title" type="button" onClick={onOpen}>{item.title}</button>
        <p>{meta.label} <i /> {item.publisher}</p>
        <div className="product-footer">
          <span className="rating"><Star /> 4.8 <small>(1.2k)</small></span>
          <strong>{currency(item.priceCents)}</strong>
          <button type="button" onClick={onCart} aria-label="Añadir al carrito"><ShoppingCart /></button>
        </div>
      </div>
    </article>
  );
}

function Modal({ children, onClose, className = "" }: { children: React.ReactNode; onClose: () => void; className?: string }) {
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className={`modal ${className}`} role="dialog" aria-modal="true">
        <button className="modal-close" type="button" onClick={onClose} aria-label="Cerrar"><X /></button>
        {children}
      </section>
    </div>
  );
}

export default function App() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("inicio");
  const [filter, setFilter] = useState<Filter>("todos");
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<Set<number>>(new Set());
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selected, setSelected] = useState<Listing | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState("");
  const [publishAfterAuth, setPublishAfterAuth] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [creatorGateOpen, setCreatorGateOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishCategory, setPublishCategory] = useState<Category>("juego");
  const [publishing, setPublishing] = useState(false);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [adminTab, setAdminTab] = useState<AdminTab>("resumen");
  const [adminSummary, setAdminSummary] = useState<AdminSummary | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminListings, setAdminListings] = useState<AdminListing[]>([]);
  const [adminBookings, setAdminBookings] = useState<AdminBooking[]>([]);
  const [adminOrders, setAdminOrders] = useState<AdminOrder[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [managedUserOpen, setManagedUserOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editingListing, setEditingListing] = useState<AdminListing | null>(null);
  const [session, setSession] = useState<AuthSession | null>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem("takana-session") || "null") as AuthSession | null;
      return stored?.token && stored?.user ? stored : null;
    }
    catch { return null; }
  });
  const user = session?.user || null;
  const authToken = session?.token || "";
  const isSuperadmin = user?.role === "superadmin";
  const isAdmin = isSuperadmin || user?.role === "admin";

  const loadListings = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/listings");
      const data = await response.json() as { items?: Listing[]; error?: string };
      if (!response.ok) throw new Error(data.error);
      setListings(data.items || []);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "No se pudo cargar el catálogo local.");
    } finally { setLoading(false); }
  };

  const loadAccountData = async (token: string) => {
    const headers = { authorization: `Bearer ${token}` };
    const [profileResponse, favoritesResponse, cartResponse] = await Promise.all([
      fetch("/api/auth/me", { headers }),
      fetch("/api/favorites", { headers }),
      fetch("/api/cart", { headers }),
    ]);
    if (!profileResponse.ok) throw new Error("La sesión local venció.");
    const profile = await profileResponse.json() as { user: AuthUser };
    const favoriteData = await favoritesResponse.json() as { ids?: number[] };
    const cartData = await cartResponse.json() as CartData;
    setSession((current) => current ? { ...current, user: profile.user } : current);
    setFavorites(new Set(favoriteData.ids || []));
    setCart(cartData.items || []);
  };

  /** Canjea el refresh token por un token de acceso nuevo. */
  const refreshSession = async () => {
    const refreshToken = session?.refreshToken;
    if (!refreshToken) return;
    try {
      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      const data = await response.json() as { user?: AuthUser; token?: string; refreshToken?: string; expiresAt?: string };
      if (!response.ok || !data.user || !data.token || !data.expiresAt) throw new Error();
      const renewed = { user: data.user, token: data.token, refreshToken: data.refreshToken || refreshToken, expiresAt: data.expiresAt };
      setSession(renewed);
      window.localStorage.setItem("takana-session", JSON.stringify(renewed));
    } catch {
      clearSession();
      setFeedback("Tu sesión venció. Inicia sesión de nuevo.");
    }
  };

  const clearSession = () => {
    setSession(null);
    setCreatorGateOpen(false);
    setFavorites(new Set());
    setCart([]);
    window.localStorage.removeItem("takana-session");
    window.localStorage.removeItem("takana-user");
  };

  const loadAdminData = async () => {
    if (!authToken || !isAdmin) return;
    setAdminLoading(true);
    try {
      const headers = { authorization: `Bearer ${authToken}` };
      const requests = [
        fetch("/api/admin/summary", { headers }),
        fetch("/api/admin/listings", { headers }),
        fetch("/api/admin/bookings", { headers }),
        fetch("/api/admin/orders", { headers }),
        ...(isSuperadmin ? [fetch("/api/admin/users", { headers })] : []),
      ];
      const responses = await Promise.all(requests);
      const payloads = await Promise.all(responses.map((response) => response.json()));
      const failed = responses.findIndex((response) => !response.ok);
      if (failed >= 0) throw new Error(payloads[failed]?.error || "No se pudo cargar el panel.");
      setAdminSummary(payloads[0] as AdminSummary);
      setAdminListings((payloads[1]?.items || []) as AdminListing[]);
      setAdminBookings((payloads[2]?.items || []) as AdminBooking[]);
      setAdminOrders((payloads[3]?.items || []) as AdminOrder[]);
      setAdminUsers(isSuperadmin ? ((payloads[4]?.items || []) as AdminUser[]) : []);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "No se pudo cargar el panel administrativo.");
    } finally {
      setAdminLoading(false);
    }
  };

  useEffect(() => { void loadListings(); }, []);
  useEffect(() => {
    if (!authToken) return;
    void loadAccountData(authToken).catch((error) => {
      clearSession();
      setFeedback(error instanceof Error ? error.message : "No se pudo recuperar la sesión local.");
    });
  }, [authToken]);
  // El token de acceso de Supabase caduca en ~1 hora. Se renueva un minuto
  // antes de que venza para que la sesión no se corte mientras se navega.
  useEffect(() => {
    if (!session?.refreshToken || !session.expiresAt) return;
    const margin = 60_000;
    const delay = Math.max(5_000, new Date(session.expiresAt).getTime() - Date.now() - margin);
    const timer = window.setTimeout(() => { void refreshSession(); }, delay);
    return () => window.clearTimeout(timer);
  }, [session?.refreshToken, session?.expiresAt]);
  useEffect(() => {
    if (view === "administracion" && isAdmin) void loadAdminData();
  }, [view, authToken, isAdmin, isSuperadmin]);
  useEffect(() => {
    if (!isSuperadmin && adminTab === "usuarios") setAdminTab("resumen");
  }, [isSuperadmin, adminTab]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(""), 3400);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const shownListings = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("es");
    return listings.filter((item) => (filter === "todos" || item.category === filter)
      && (!normalized || `${item.title} ${item.description} ${item.publisher}`.toLocaleLowerCase("es").includes(normalized)));
  }, [filter, listings, query]);

  const navigate = (nextView: View) => {
    setView(nextView);
    setMobileOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const chooseCategory = (category: Filter) => {
    setFilter(category);
    navigate("catalogo");
  };

  const openAuth = (mode: "login" | "register" = "login", continueToPublish = false) => {
    setPublishAfterAuth(continueToPublish);
    setAuthMode(mode);
    setAuthError("");
    setAuthOpen(true);
  };

  const closeAuth = () => {
    if (authSubmitting) return;
    setAuthError("");
    setPublishAfterAuth(false);
    setAuthOpen(false);
  };

  const openPublish = () => {
    setMobileOpen(false);
    if (!authToken) {
      openAuth("register", true);
      setFeedback("Crea una cuenta para publicar tu juego, software o proyecto.");
      return;
    }
    setCreatorGateOpen(true);
  };

  const addCart = async (item: Listing) => {
    if (!authToken) {
      openAuth("login");
      setFeedback("Inicia sesión para guardar productos en tu carrito.");
      return;
    }
    const response = await fetch("/api/cart/items", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ listingId: item.id }),
    });
    const data = await response.json() as CartData;
    if (!response.ok) { setFeedback(data.error || "No se pudo actualizar el carrito."); return; }
    setCart(data.items);
    setFeedback(`${item.title} se guardó en tu carrito local.`);
  };

  const removeCart = async (listingId: number) => {
    if (!authToken) return;
    const response = await fetch(`/api/cart/items/${listingId}`, {
      method: "DELETE", headers: { authorization: `Bearer ${authToken}` },
    });
    const data = await response.json() as CartData;
    if (!response.ok) { setFeedback(data.error || "No se pudo quitar el producto."); return; }
    setCart(data.items);
  };

  const toggleFavorite = async (id: number) => {
    if (!authToken) {
      openAuth("login");
      setFeedback("Inicia sesión para guardar favoritos.");
      return;
    }
    const isFavorite = favorites.has(id);
    const response = await fetch(`/api/favorites/${id}`, {
      method: isFavorite ? "DELETE" : "POST",
      headers: { authorization: `Bearer ${authToken}` },
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) { setFeedback(data.error || "No se pudo actualizar favoritos."); return; }
    setFavorites((current) => {
      const next = new Set(current);
      if (isFavorite) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setAuthSubmitting(true);
    setAuthError("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: authMode,
          name: String(formData.get("name") || "").trim(),
          email: String(formData.get("email") || "").trim().toLowerCase(),
          password: String(formData.get("password") || ""),
        }),
      });
      const data = await response.json() as { user?: AuthUser; token?: string; refreshToken?: string; expiresAt?: string; error?: string };
      if (!response.ok || !data.user || !data.token || !data.expiresAt) {
        setAuthError(data.error || "No se pudo completar el acceso.");
        return;
      }
      const nextSession = { user: data.user, token: data.token, refreshToken: data.refreshToken || "", expiresAt: data.expiresAt };
      setSession(nextSession);
      window.localStorage.setItem("takana-session", JSON.stringify(nextSession));
      window.localStorage.removeItem("takana-user");
      form.reset();
      const continueToPublish = publishAfterAuth;
      setAuthOpen(false);
      setAuthMode("login");
      setPublishAfterAuth(false);
      if (continueToPublish) {
        setPublishOpen(true);
        setFeedback(authMode === "register"
          ? `Cuenta creada. Ya puedes subir tu juego o proyecto, ${data.user.name}.`
          : `Bienvenido de nuevo, ${data.user.name}. Ya puedes publicar.`);
      } else {
        setFeedback(authMode === "register" ? `Cuenta creada. Bienvenido, ${data.user.name}.` : `Bienvenido de nuevo, ${data.user.name}.`);
      }
    } catch {
      const message = "No se pudo conectar con TAKANA. Verifica que el servidor local esté encendido.";
      setAuthError(message);
      setFeedback(message);
    } finally {
      setAuthSubmitting(false);
    }
  };

  const logout = async () => {
    try {
      if (authToken) await fetch("/api/auth/session", { method: "DELETE", headers: { authorization: `Bearer ${authToken}` } });
    } finally {
      clearSession();
      setAccountOpen(false);
      setCreatorGateOpen(false);
      setAuthMode("login");
      setView("inicio");
      setFeedback("Sesión local cerrada.");
    }
  };

  const submitListing = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    formData.set("priceCents", String(Math.round(Number(formData.get("price")) * 100)));
    formData.delete("price");
    setPublishing(true);
    try {
      const response = await fetch("/api/listings", {
        method: "POST",
        headers: { authorization: `Bearer ${authToken}` },
        body: formData,
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) { setFeedback(data.error || "No se pudo publicar."); return; }
      form.reset();
      setPublishCategory("juego");
      setPublishOpen(false);
      await loadListings();
      setFeedback(publishCategory === "servicio" ? "Servicio publicado en SQLite local." : "Proyecto y archivo descargable guardados localmente.");
      chooseCategory("todos");
    } catch {
      setFeedback("No se pudo conectar con el servidor local para subir el archivo del proyecto.");
    } finally {
      setPublishing(false);
    }
  };

  const downloadDistribution = async (item: Listing) => {
    if (!authToken) {
      openAuth("login");
      setFeedback("Inicia sesión para descargar el proyecto.");
      return;
    }
    try {
      setFeedback("Preparando la descarga local...");
      const response = await fetch(`/api/listings/${item.id}/download`, {
        headers: { authorization: `Bearer ${authToken}` },
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        setFeedback(data.error || "No se pudo descargar el proyecto.");
        return;
      }
      const distribution = await response.blob();
      const downloadUrl = window.URL.createObjectURL(distribution);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = item.downloadFilename || `${item.slug}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 1000);
      setFeedback(`Descargando ${link.download}.`);
    } catch {
      setFeedback("No se pudo iniciar la descarga desde el almacenamiento local.");
    }
  };

  const submitBooking = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const service = listings.find((item) => item.category === "servicio");
    if (!service) { setFeedback("No hay servicios disponibles."); return; }
    const form = event.currentTarget;
    const formData = new FormData(form);
    const response = await fetch("/api/bookings", {
      method: "POST", headers: { "content-type": "application/json", ...(authToken ? { authorization: `Bearer ${authToken}` } : {}) },
      body: JSON.stringify({ listingId: service.id, customerName: formData.get("name"), customerEmail: formData.get("email"), scheduledDate: formData.get("date"), notes: formData.get("notes") }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) { setFeedback(data.error || "No se pudo agendar."); return; }
    setBookingOpen(false);
    setFeedback("Cita guardada en el equipo.");
  };

  const checkout = async () => {
    if (!authToken) return;
    const response = await fetch("/api/orders/checkout", { method: "POST", headers: { authorization: `Bearer ${authToken}` } });
    const data = await response.json() as { id?: number; totalCents?: number; error?: string };
    if (!response.ok || !data.id) { setFeedback(data.error || "No se pudo confirmar la compra."); return; }
    setCart([]);
    setCartOpen(false);
    setFeedback(`Pedido #${data.id} confirmado y guardado en SQLite.`);
  };

  const adminMutation = async (url: string, method: "POST" | "PUT" | "DELETE", body?: unknown) => {
    const response = await fetch(url, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${authToken}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) { setFeedback(data.error || "No se pudo completar la acción administrativa."); return false; }
    await loadAdminData();
    return true;
  };

  const submitManagedUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const success = await adminMutation("/api/admin/users", "POST", {
      name: formData.get("name"), email: formData.get("email"), password: formData.get("password"), role: formData.get("role"),
    });
    if (!success) return;
    form.reset();
    setManagedUserOpen(false);
    setFeedback("Cuenta administrativa creada correctamente.");
  };

  const submitManagedUserEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingUser) return;
    const formData = new FormData(event.currentTarget);
    const success = await adminMutation(`/api/admin/users/${editingUser.id}`, "PUT", {
      name: formData.get("name"),
      role: formData.get("role"),
      active: formData.get("active") === "on",
    });
    if (!success) return;
    if (editingUser.id === user?.id) await loadAccountData(authToken);
    setEditingUser(null);
    setFeedback("Usuario y permisos actualizados.");
  };

  const updateAdminUser = async (managedUser: AdminUser, changes: Partial<Pick<AdminUser, "name" | "role" | "active">>) => {
    const success = await adminMutation(`/api/admin/users/${managedUser.id}`, "PUT", changes);
    if (success && managedUser.id === user?.id) await loadAccountData(authToken);
  };

  const deactivateAdminUser = async (managedUser: AdminUser) => {
    if (!window.confirm(`¿Desactivar la cuenta de ${managedUser.name}?`)) return;
    const success = await adminMutation(`/api/admin/users/${managedUser.id}`, "DELETE");
    if (success) setFeedback("Cuenta desactivada. Sus datos históricos se conservaron.");
  };

  const submitListingEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingListing) return;
    const formData = new FormData(event.currentTarget);
    const success = await adminMutation(`/api/admin/listings/${editingListing.id}`, "PUT", {
      title: formData.get("title"),
      description: formData.get("description"),
      category: formData.get("category"),
      priceCents: Math.round(Number(formData.get("price")) * 100),
      featured: formData.get("featured") === "on",
      ...(isSuperadmin ? { published: formData.get("published") === "on" } : {}),
    });
    if (!success) return;
    setEditingListing(null);
    await loadListings();
    setFeedback("Publicación actualizada.");
  };

  const archiveAdminListing = async (item: AdminListing) => {
    if (!window.confirm(`¿Retirar ${item.title} del catálogo?`)) return;
    const success = await adminMutation(`/api/admin/listings/${item.id}`, "DELETE");
    if (success) { await loadListings(); setFeedback("Publicación retirada del catálogo."); }
  };

  const updateAdminBooking = async (id: number, status: string) => {
    if (await adminMutation(`/api/admin/bookings/${id}`, "PUT", { status })) setFeedback("Estado de cita actualizado.");
  };

  const deleteAdminBooking = async (id: number) => {
    if (!window.confirm("¿Eliminar esta cita definitivamente?")) return;
    if (await adminMutation(`/api/admin/bookings/${id}`, "DELETE")) setFeedback("Cita eliminada.");
  };

  const updateAdminOrder = async (id: number, status: string) => {
    if (await adminMutation(`/api/admin/orders/${id}`, "PUT", { status })) setFeedback("Estado del pedido actualizado.");
  };

  const deleteAdminOrder = async (id: number) => {
    if (!window.confirm("¿Eliminar este pedido y sus productos?")) return;
    if (await adminMutation(`/api/admin/orders/${id}`, "DELETE")) setFeedback("Pedido eliminado.");
  };

  const cartCount = cart.reduce((total, item) => total + item.quantity, 0);
  const cartTotal = cart.reduce((total, item) => total + item.priceCents * item.quantity, 0);
  const visibleListings = view === "inicio" ? listings.slice(0, 4) : shownListings.slice(0, 8);

  return (
    <div className="app">
      <header className="topbar">
        <Brand onClick={() => navigate("inicio")} />
        <button className="mobile-menu" type="button" onClick={() => setMobileOpen((open) => !open)} aria-label="Abrir menú"><Menu /></button>
        <nav className={mobileOpen ? "open" : ""} aria-label="Navegación principal">
          <button className={view === "inicio" ? "active" : ""} type="button" onClick={() => navigate("inicio")}>Inicio</button>
          <button className={view === "catalogo" && filter === "juego" ? "active" : ""} type="button" onClick={() => chooseCategory("juego")}>Juegos</button>
          <button className={view === "catalogo" && filter === "software" ? "active" : ""} type="button" onClick={() => chooseCategory("software")}>Software</button>
          <button className={view === "servicios" ? "active" : ""} type="button" onClick={() => navigate("servicios")}>Soporte técnico</button>
          <button className={view === "como-funciona" ? "active" : ""} type="button" onClick={() => navigate("como-funciona")}>Cómo funciona</button>
          <button type="button" onClick={openPublish}>Vender en TAKANA</button>
          {isAdmin && <button className={view === "administracion" ? "active admin-nav" : "admin-nav"} type="button" onClick={() => navigate("administracion")}><UserCog /> Panel</button>}
        </nav>
        <label className="global-search">
          <Search />
          <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") navigate("catalogo"); }} placeholder="Buscar juegos, software, servicios y más..." />
          <span>Todo <ChevronDown /></span>
        </label>
        <div className="top-actions">
          <button className="cart-button" type="button" onClick={() => setCartOpen(true)} aria-label="Abrir carrito"><ShoppingCart />{cartCount > 0 && <b>{cartCount}</b>}</button>
          {user ? <button className="profile-chip" type="button" onClick={() => setAccountOpen(true)} aria-label={`Abrir cuenta de ${user.name}`}><span>{user.name.slice(0, 1).toUpperCase()}</span><small>Hola,</small><strong>{user.name}</strong><ChevronDown /></button>
            : <button className="profile-chip" type="button" onClick={() => openAuth("login")} aria-label="Iniciar sesión o crear cuenta"><span><UserRound /></span><small>Hola,</small><strong>Ingresar</strong><ChevronDown /></button>}
        </div>
      </header>

      <main className={`view-shell view-${view}`}>
        {view === "inicio" && <>
          <section className="hero">
            <div className="hero-grid" aria-hidden="true" />
            <div className="hero-copy">
              <span className="eyebrow"><Sparkles /> Marketplace creativo local</span>
              <h1>Tu mundo digital,<br /><em>sin límites.</em></h1>
              <p>Descubre juegos increíbles, software potente y soporte técnico de expertos. Todo en un solo lugar.</p>
              <div className="hero-actions">
                <button className="primary-button" type="button" onClick={() => chooseCategory("todos")}><Gamepad2 /> Explorar catálogo</button>
                <button className="secondary-button" type="button" onClick={openPublish}><Upload /> Publicar proyecto</button>
              </div>
              <div className="hero-trust">
                <span><ShieldCheck /><b>Datos locales</b><small>Protección en tu equipo</small></span>
                <span><BadgeCheck /><b>Creadores verificados</b><small>Contenido seleccionado</small></span>
                <span><Headphones /><b>Soporte real</b><small>Atención especializada</small></span>
              </div>
            </div>
            <div className="hero-art" aria-hidden="true">
              <img src="/assets/hero-light-neon.png" alt="" />
              <span className="hero-stat"><BarChart3 /><b>+24%</b><small>creadores</small></span>
              <span className="hero-orbit orbit-one"><Code2 /></span>
              <span className="hero-orbit orbit-two"><Sparkles /></span>
            </div>
          </section>

          <section className="category-row" aria-label="Categorías">
            {([
              ["juego", "Los mejores títulos para todos los gamers."],
              ["software", "Herramientas y programas para llevar tus ideas más lejos."],
              ["servicio", "Expertos listos para resolver cualquier problema técnico."],
            ] as const).map(([category, description]) => {
              const meta = categoryCopy[category];
              const Icon = meta.icon;
              return <button className={`category-card category-${meta.tone}`} type="button" onClick={() => category === "servicio" ? navigate("servicios") : chooseCategory(category)} key={category}><span><Icon /></span><div><strong>{meta.plural}</strong><small>{description}</small></div><ArrowRight /></button>;
            })}
          </section>
        </>}

        {view === "catalogo" && <section className="page-banner catalog-banner">
          <div><span><Gamepad2 /> CATÁLOGO DIGITAL</span><h1>Explora, descubre y crea.</h1><p>Juegos, herramientas y servicios seleccionados para tu próximo proyecto.</p></div>
          <button className="secondary-button" type="button" onClick={openPublish}><Upload /> Publicar proyecto</button>
        </section>}

        {(view === "inicio" || view === "catalogo") && <section className={`catalog-section ${view === "catalogo" ? "catalog-page" : "home-catalog"}`}>
          <div className="section-heading">
            <div><span><Zap /> Selección TAKANA</span><h2>{view === "inicio" || filter === "todos" ? "Destacados para ti" : categoryCopy[filter].plural}</h2></div>
            {view === "catalogo" ? <div className="catalog-controls">
              {(["todos", "juego", "software", "servicio"] as Filter[]).map((item) => <button className={filter === item ? "active" : ""} type="button" key={item} onClick={() => setFilter(item)}>{item === "todos" ? "Todos" : categoryCopy[item].plural}</button>)}
            </div> : <button className="view-all-button" type="button" onClick={() => chooseCategory("todos")}>Ver catálogo completo <ArrowRight /></button>}
          </div>
          {loading ? <div className="loading"><RefreshCw /> Cargando catálogo local...</div> : visibleListings.length ? (
            <div className="product-grid">
              {visibleListings.map((item) => <ProductCard key={item.id} item={item} favorite={favorites.has(item.id)} onFavorite={() => toggleFavorite(item.id)} onOpen={() => setSelected(item)} onCart={() => addCart(item)} />)}
            </div>
          ) : <div className="empty-state"><Search /><h3>No encontramos resultados</h3><p>Prueba otra búsqueda o categoría.</p><button type="button" onClick={() => { setQuery(""); setFilter("todos"); }}>Limpiar filtros</button></div>}
        </section>}

        {view === "inicio" && <section className="benefits">
          <article><ShieldCheck /><div><strong>Transacciones locales</strong><small>Tus datos permanecen en este equipo</small></div></article>
          <article><RefreshCw /><div><strong>Garantía de satisfacción</strong><small>Procesos claros y sin complicaciones</small></div></article>
          <article><Sparkles /><div><strong>Ofertas exclusivas</strong><small>Contenido nuevo cada semana</small></div></article>
          <article><UsersRound /><div><strong>Comunidad creciente</strong><small>Creadores y jugadores conectados</small></div></article>
          <button type="button" onClick={openPublish}><Upload /><span><small>¿Tienes un talento o servicio?</small><strong>Publicar proyecto</strong></span><ArrowRight /></button>
        </section>}

        {view === "servicios" && <section className="services-section services-page">
          <div className="services-copy"><span><Wrench /> TAKANA TECH</span><h2>Tu equipo siempre<br /><em>en su mejor nivel.</em></h2><p>Diagnóstico, mantenimiento preventivo y optimización realizados por especialistas.</p><button className="primary-button" type="button" onClick={() => setBookingOpen(true)}><CalendarDays /> Agendar soporte</button></div>
          <div className="service-cards">
            <article><MonitorCog /><span>01</span><h3>Mantenimiento preventivo</h3><p>Limpieza, revisión térmica y reporte técnico.</p><b>Desde $25</b></article>
            <article><Laptop /><span>02</span><h3>Diagnóstico completo</h3><p>Hardware y software con soluciones claras.</p><b>Desde $15</b></article>
            <article><Zap /><span>03</span><h3>Optimización</h3><p>Arranque, rendimiento y estabilidad del sistema.</p><b>Desde $20</b></article>
          </div>
        </section>}

        {view === "como-funciona" && <section className="how-section how-page">
          <div className="how-intro"><span><PackageCheck /> SIMPLE, SEGURO Y LOCAL</span><h1>Todo lo que necesitas,<br /><em>en tres pasos.</em></h1><p>TAKANA conecta creadores, jugadores y especialistas sin enviar tus datos a la nube.</p></div>
          <div className="steps"><article><span>01</span><Search /><h3>Explora</h3><p>Encuentra juegos, software o asistencia técnica.</p></article><ArrowRight /><article><span>02</span><ShoppingCart /><h3>Selecciona</h3><p>Revisa todos los detalles y agrega a tu carrito.</p></article><ArrowRight /><article><span>03</span><Check /><h3>Disfruta</h3><p>Recibe tu producto o confirma tu cita localmente.</p></article></div>
          <div className="how-actions"><button className="primary-button" type="button" onClick={() => chooseCategory("todos")}>Explorar catálogo <ArrowRight /></button><button className="secondary-button" type="button" onClick={openPublish}>Publicar en TAKANA</button></div>
        </section>}

        {view === "administracion" && (isAdmin ? <section className="admin-page">
          <aside className="admin-sidebar">
            <div className="admin-identity"><span>{isSuperadmin ? <Crown /> : <UserCog />}</span><small>Panel protegido</small><strong>{isSuperadmin ? "Superadmin" : "Administrador"}</strong><p>{user?.email}</p></div>
            <nav aria-label="Secciones administrativas">
              <button className={adminTab === "resumen" ? "active" : ""} type="button" onClick={() => setAdminTab("resumen")}><BarChart3 /> Resumen</button>
              {isSuperadmin && <button className={adminTab === "usuarios" ? "active" : ""} type="button" onClick={() => setAdminTab("usuarios")}><UsersRound /> Usuarios</button>}
              <button className={adminTab === "publicaciones" ? "active" : ""} type="button" onClick={() => setAdminTab("publicaciones")}><Database /> Publicaciones</button>
              <button className={adminTab === "citas" ? "active" : ""} type="button" onClick={() => setAdminTab("citas")}><CalendarDays /> Citas</button>
              <button className={adminTab === "pedidos" ? "active" : ""} type="button" onClick={() => setAdminTab("pedidos")}><ClipboardList /> Pedidos</button>
            </nav>
            <div className="permission-note"><ShieldCheck /><div><strong>{isSuperadmin ? "Control total" : "Sin eliminación"}</strong><small>{isSuperadmin ? "Roles, estados y contenido" : "Puedes crear y editar, nunca eliminar"}</small></div></div>
          </aside>

          <div className="admin-content">
            <header className="admin-heading"><div><span><Zap /> CENTRO DE CONTROL LOCAL</span><h1>{adminTab === "resumen" ? "Resumen general" : adminTab.charAt(0).toUpperCase() + adminTab.slice(1)}</h1><p>Gestiona TAKANA desde SQLite, sin servicios externos.</p></div><div>{isSuperadmin && adminTab === "usuarios" && <button className="primary-button" type="button" onClick={() => setManagedUserOpen(true)}><Plus /> Crear cuenta</button>}{adminTab === "publicaciones" && <button className="primary-button" type="button" onClick={openPublish}><Plus /> Nueva publicación</button>}<button className="admin-refresh" type="button" onClick={() => void loadAdminData()} aria-label="Actualizar panel"><RefreshCw /></button></div></header>

            {adminLoading ? <div className="admin-loading"><RefreshCw /> Actualizando panel...</div> : <>
              {adminTab === "resumen" && <>
                <div className="admin-metrics">
                  <article><span className="metric-violet"><CircleUserRound /></span><div><small>Usuarios activos</small><strong>{adminSummary?.users || 0}</strong><em>{adminSummary?.admins || 0} administradores</em></div></article>
                  <article><span className="metric-cyan"><Database /></span><div><small>Publicaciones</small><strong>{adminSummary?.listings || 0}</strong><em>visibles en catálogo</em></div></article>
                  <article><span className="metric-orange"><CalendarDays /></span><div><small>Citas</small><strong>{adminSummary?.bookings || 0}</strong><em>{adminSummary?.pendingBookings || 0} pendientes</em></div></article>
                  <article><span className="metric-lime"><ShoppingCart /></span><div><small>Pedidos</small><strong>{adminSummary?.orders || 0}</strong><em>{currency(adminSummary?.salesCents || 0)} registrados</em></div></article>
                </div>
                <div className="admin-overview-grid">
                  <article><div className="overview-title"><ShieldCheck /><div><strong>Matriz de permisos activa</strong><small>Validada tanto en la interfaz como en la API</small></div></div><div className="permission-row"><b>Superadmin</b><span>Usuarios · Roles · Crear · Editar · Desactivar</span><i>Control total</i></div><div className="permission-row"><b>Admin</b><span>Publicaciones · Citas · Pedidos</span><i>Crear y editar</i></div><div className="permission-row"><b>Usuario</b><span>Cuenta · Compras · Favoritos · Publicaciones propias</span><i>Uso normal</i></div></article>
                  <article className="admin-status-card"><Database /><span><small>Motor de datos</small><strong>SQLite local</strong></span><BadgeCheck /><p>Los permisos se comprueban en cada solicitud. Ocultar un botón no sustituye la seguridad del servidor.</p></article>
                </div>
              </>}

              {adminTab === "usuarios" && isSuperadmin && <div className="admin-table-card"><div className="table-title"><div><h2>Usuarios y permisos</h2><p>Sólo el superadmin puede editar cuentas, asignar roles o desactivarlas.</p></div><span>{adminUsers.length} cuentas</span></div><div className="admin-table-wrap"><table><thead><tr><th>Usuario</th><th>Rol y alcance</th><th>Estado</th><th>Registro</th><th>Acciones</th></tr></thead><tbody>{adminUsers.map((managedUser) => <tr key={managedUser.id}><td><div className="user-cell"><span>{managedUser.name.slice(0, 1).toUpperCase()}</span><div><strong>{managedUser.name}</strong><small>{managedUser.email}</small></div></div></td><td><span className={`role-pill role-${managedUser.role}`}>{managedUser.role === "superadmin" ? "Control total" : managedUser.role === "admin" ? "Crear y editar" : "Cuenta de usuario"}</span></td><td><span className={`status-pill ${managedUser.active ? "status-active" : "status-inactive"}`}>{managedUser.active ? "Activo" : "Desactivado"}</span></td><td>{new Date(managedUser.createdAt).toLocaleDateString("es-EC")}</td><td><div className="row-actions"><button type="button" onClick={() => setEditingUser(managedUser)} aria-label={`Editar permisos de ${managedUser.name}`}><Edit3 /></button><button type="button" onClick={() => managedUser.active ? void deactivateAdminUser(managedUser) : void updateAdminUser(managedUser, { active: true })} aria-label={managedUser.active ? `Desactivar ${managedUser.name}` : `Activar ${managedUser.name}`}><Trash2 /></button></div></td></tr>)}</tbody></table></div></div>}

              {adminTab === "publicaciones" && <div className="admin-table-card"><div className="table-title"><div><h2>Catálogo completo</h2><p>{isSuperadmin ? "Edita, destaca o retira cualquier publicación." : "Puedes crear y editar; eliminar está bloqueado para tu rol."}</p></div><span>{adminListings.length} registros</span></div><div className="admin-table-wrap"><table><thead><tr><th>Publicación</th><th>Categoría</th><th>Precio</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{adminListings.map((item) => <tr key={item.id}><td><div className="listing-cell"><img src={covers[item.coverKey] || covers.orbit} alt="" /><div><strong>{item.title}</strong><small>{item.publisher}</small></div></div></td><td><span className={`product-badge badge-${categoryCopy[item.category].tone}`}>{categoryCopy[item.category].label}</span></td><td><b>{currency(item.priceCents)}</b></td><td><span className={`status-pill ${item.published ? "status-active" : "status-inactive"}`}>{item.published ? "Publicada" : "Retirada"}</span></td><td><div className="row-actions"><button type="button" onClick={() => setEditingListing(item)} aria-label={`Editar ${item.title}`}><Edit3 /></button>{isSuperadmin && item.published && <button className="danger" type="button" onClick={() => void archiveAdminListing(item)} aria-label={`Retirar ${item.title}`}><Trash2 /></button>}</div></td></tr>)}</tbody></table></div></div>}

              {adminTab === "citas" && <div className="admin-table-card"><div className="table-title"><div><h2>Citas de soporte</h2><p>Actualiza el progreso del servicio técnico.</p></div><span>{adminBookings.length} citas</span></div><div className="admin-table-wrap"><table><thead><tr><th>Cliente</th><th>Servicio</th><th>Fecha</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{adminBookings.map((booking) => <tr key={booking.id}><td><div className="text-cell"><strong>{booking.customerName}</strong><small>{booking.customerEmail}</small></div></td><td>{booking.listingTitle}</td><td>{booking.scheduledDate}</td><td><select value={booking.status} onChange={(event) => void updateAdminBooking(booking.id, event.target.value)}><option value="pendiente">Pendiente</option><option value="confirmada">Confirmada</option><option value="completada">Completada</option><option value="cancelada">Cancelada</option></select></td><td><div className="row-actions"><button type="button" onClick={() => void updateAdminBooking(booking.id, booking.status)}><Edit3 /></button>{isSuperadmin && <button className="danger" type="button" onClick={() => void deleteAdminBooking(booking.id)}><Trash2 /></button>}</div></td></tr>)}</tbody></table></div></div>}

              {adminTab === "pedidos" && <div className="admin-table-card"><div className="table-title"><div><h2>Pedidos locales</h2><p>Controla la entrega y conserva el historial de ventas.</p></div><span>{adminOrders.length} pedidos</span></div><div className="admin-table-wrap"><table><thead><tr><th>Pedido</th><th>Cliente</th><th>Total</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{adminOrders.map((order) => <tr key={order.id}><td><div className="text-cell"><strong>#{order.id}</strong><small>{new Date(order.createdAt).toLocaleDateString("es-EC")}</small></div></td><td><div className="text-cell"><strong>{order.customerName}</strong><small>{order.customerEmail}</small></div></td><td><b>{currency(order.totalCents)}</b></td><td><select value={order.status} onChange={(event) => void updateAdminOrder(order.id, event.target.value)}><option value="confirmado">Confirmado</option><option value="procesando">Procesando</option><option value="completado">Completado</option><option value="cancelado">Cancelado</option></select></td><td><div className="row-actions"><button type="button" onClick={() => void updateAdminOrder(order.id, order.status)}><Edit3 /></button>{isSuperadmin && <button className="danger" type="button" onClick={() => void deleteAdminOrder(order.id)}><Trash2 /></button>}</div></td></tr>)}</tbody></table></div></div>}
            </>}
          </div>
        </section> : <section className="access-denied"><ShieldCheck /><h1>Acceso administrativo</h1><p>Esta pantalla requiere un rol de administrador.</p><button className="primary-button" type="button" onClick={() => openAuth("login")}>Iniciar sesión</button></section>)}
      </main>

      {creatorGateOpen && user && <Modal className="form-modal creator-gate-modal" onClose={() => setCreatorGateOpen(false)}><span className="modal-kicker"><ShieldCheck /> CUENTA OBLIGATORIA PARA PUBLICAR</span><h2>Confirma tu cuenta de creador</h2><p>Todo juego, software o proyecto debe quedar asociado a una cuenta registrada.</p><div className="creator-account-card"><span>{user.name.slice(0, 1).toUpperCase()}</span><div><small>Publicarás como</small><strong>{user.name}</strong><p>{user.email}</p></div><BadgeCheck /></div><div className="creator-gate-note"><LockKeyhole /><p><strong>Cuenta verificada</strong><span>Tu publicación quedará protegida y vinculada a este perfil.</span></p></div><button className="primary-button" type="button" onClick={() => { setCreatorGateOpen(false); setPublishOpen(true); setFeedback(`Cuenta confirmada: ${user.name}.`); }}>Continuar y subir proyecto <ArrowRight /></button></Modal>}

      <footer>
        <Brand onClick={() => navigate("inicio")} />
        <p>Juegos, software y soporte técnico en un solo lugar.<br />{PROJECT_IDENTITY.copyright}</p>
        <nav className="footer-social" aria-label="Redes sociales de TAKANA">
          <a href="https://www.tiktok.com/@takanateam" target="_blank" rel="noopener noreferrer" aria-label="TikTok de TAKANA" title="TikTok">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.6 5.4a4.5 4.5 0 0 1-2.8-2.8h-3v12.2a2.7 2.7 0 1 1-1.9-2.6V9.1a5.8 5.8 0 1 0 5 5.7V8.6a7.5 7.5 0 0 0 4.4 1.4V7a4.5 4.5 0 0 1-1.7-1.6Z" /></svg>
          </a>
          <a href="https://www.instagram.com/takanateam?igsh=Z3hrZmlqNXUyeDY4&igsi=Z3hrZmlqNXUyeDY4" target="_blank" rel="noopener noreferrer" aria-label="Instagram de TAKANA" title="Instagram"><Instagram /></a>
        </nav>
      </footer>

      {selected && <Modal className="product-modal" onClose={() => setSelected(null)}><div className="modal-product-art"><img src={covers[selected.coverKey] || covers.orbit} alt="" /></div><div className="modal-product-copy"><span className={`product-badge badge-${categoryCopy[selected.category].tone}`}>{categoryCopy[selected.category].label}</span><h2>{selected.title}</h2><p>{selected.description}</p><div className="modal-rating"><Star /> 4.8 <small>128 reseñas verificadas</small></div><strong>{currency(selected.priceCents)}</strong><ul><li><Check /> Entrega o confirmación inmediata</li><li><Check /> Publicado por {selected.publisher}</li><li><Check /> Datos guardados localmente</li>{selected.hasExecutable && <li><Download /> {distributionKind(selected.downloadFilename)} · {fileSize(selected.downloadSize)}</li>}</ul><div className="modal-product-actions">{selected.hasExecutable && <button className="secondary-button" type="button" onClick={() => void downloadDistribution(selected)}><Download /> Descargar proyecto</button>}<button className="primary-button" type="button" onClick={() => { void addCart(selected); setSelected(null); }}><ShoppingCart /> Añadir al carrito</button></div></div></Modal>}

      {authOpen && <Modal className="form-modal auth-modal" onClose={closeAuth}><span className="modal-kicker"><LockKeyhole /> ACCESO LOCAL</span><h2>{authMode === "login" ? "Bienvenido a TAKANA" : "Crea tu cuenta"}</h2><p>{publishAfterAuth ? "Regístrate o inicia sesión para subir tu juego, software o proyecto." : "Tu perfil y tu sesión se guardan únicamente en este computador."}</p><div className="modal-tabs"><button className={authMode === "login" ? "active" : ""} type="button" disabled={authSubmitting} onClick={() => { setAuthMode("login"); setAuthError(""); }}>Ya tengo cuenta</button><button className={authMode === "register" ? "active" : ""} type="button" disabled={authSubmitting} onClick={() => { setAuthMode("register"); setAuthError(""); }}>Crear cuenta</button></div><form key={authMode} onSubmit={submitAuth}>{authMode === "register" && <label><span>Nombre</span><div><UserRound /><input name="name" autoComplete="name" required minLength={2} placeholder="Tu nombre" /></div></label>}<label><span>Correo</span><div><Mail /><input name="email" type="email" inputMode="email" autoComplete="email" required placeholder="tu@correo.com" /></div></label><label><span>Contraseña</span><div><LockKeyhole /><input name="password" type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} minLength={6} required placeholder="Mínimo 6 caracteres" /></div></label>{authError && <div className="auth-error" role="alert"><X /> <span>{authError}</span></div>}<button className="primary-button" type="submit" disabled={authSubmitting}>{authSubmitting ? <><RefreshCw className="spin" /> {authMode === "login" ? "Ingresando..." : "Creando cuenta..."}</> : <>{publishAfterAuth ? (authMode === "login" ? "Entrar y publicar" : "Crear cuenta y publicar") : (authMode === "login" ? "Entrar" : "Crear cuenta")}<ArrowRight /></>}</button></form></Modal>}

      {accountOpen && user && <Modal className="form-modal account-modal" onClose={() => setAccountOpen(false)}><span className="modal-kicker"><CircleUserRound /> CUENTA LOCAL</span><div className="account-profile"><span>{user.name.slice(0, 1).toUpperCase()}</span><div><h2>{user.name}</h2><p>{user.email}</p><small>{user.role === "superadmin" ? "Superadministrador" : user.role === "admin" ? "Administrador" : "Usuario"}</small></div></div><div className="account-actions">{isAdmin && <button className="secondary-button" type="button" onClick={() => { setAccountOpen(false); navigate("administracion"); }}><UserCog /> Abrir panel</button>}<button className="primary-button" type="button" onClick={() => void logout()}><LogOut /> Cerrar sesión</button></div></Modal>}

      {managedUserOpen && isSuperadmin && <Modal className="form-modal" onClose={() => setManagedUserOpen(false)}><span className="modal-kicker"><Crown /> GESTIÓN DE ACCESOS</span><h2>Crear cuenta administrada</h2><p>El superadministrador define el rol inicial de esta cuenta.</p><form onSubmit={submitManagedUser}><label><span>Nombre</span><input name="name" required minLength={2} placeholder="Nombre completo" /></label><label><span>Correo</span><input name="email" type="email" required placeholder="usuario@takana.local" /></label><label><span>Contraseña temporal</span><input name="password" type="password" required minLength={6} placeholder="Mínimo 6 caracteres" /></label><label><span>Rol</span><select name="role" defaultValue="usuario"><option value="usuario">Usuario</option><option value="admin">Administrador</option><option value="superadmin">Superadministrador</option></select></label><button className="primary-button" type="submit"><Plus /> Crear cuenta</button></form></Modal>}

      {editingUser && isSuperadmin && <Modal className="form-modal permission-modal" onClose={() => setEditingUser(null)}><span className="modal-kicker"><UserCog /> EDICIÓN EXCLUSIVA DEL SUPERADMIN</span><h2>Usuario y permisos</h2><p>Edita la identidad, el nivel de acceso y el estado de la cuenta.</p><form onSubmit={submitManagedUserEdit}><label><span>Nombre</span><input name="name" required minLength={2} defaultValue={editingUser.name} /></label><label><span>Correo protegido</span><input value={editingUser.email} disabled readOnly /></label><label><span>Rol y permisos</span><select name="role" defaultValue={editingUser.role}><option value="usuario">Usuario — comprar, publicar y solicitar soporte</option><option value="admin">Admin — crear y editar, sin eliminar</option><option value="superadmin">Superadmin — control total y gestión de usuarios</option></select></label><div className="role-permission-list"><article><CircleUserRound /><div><strong>Usuario</strong><small>Cuenta, carrito, favoritos, compras, citas y publicaciones propias.</small></div></article><article><UserCog /><div><strong>Administrador</strong><small>Puede crear y editar contenido, citas y pedidos. La API bloquea eliminar.</small></div></article><article><Crown /><div><strong>Superadministrador</strong><small>Gestiona usuarios, roles, estados y todos los módulos del sistema.</small></div></article></div><div className="check-grid single"><label><input name="active" type="checkbox" defaultChecked={editingUser.active} /><span>Cuenta activa y con acceso permitido</span></label></div><button className="primary-button" type="submit"><ShieldCheck /> Guardar usuario y permisos</button></form></Modal>}

      {editingListing && isAdmin && <Modal className="form-modal" onClose={() => setEditingListing(null)}><span className="modal-kicker"><Edit3 /> EDICIÓN ADMINISTRATIVA</span><h2>Editar publicación</h2><p>{isSuperadmin ? "Puedes modificar también la visibilidad del catálogo." : "Tu rol permite editar, pero no retirar publicaciones."}</p><form onSubmit={submitListingEdit}><label><span>Título</span><input name="title" required minLength={3} defaultValue={editingListing.title} /></label><label><span>Descripción</span><textarea name="description" required minLength={12} defaultValue={editingListing.description} /></label><label><span>Categoría</span><select name="category" defaultValue={editingListing.category}><option value="juego">Juego</option><option value="software">Software</option><option value="servicio">Servicio</option></select></label><label><span>Precio (USD)</span><input name="price" type="number" min="0" step="0.01" required defaultValue={(editingListing.priceCents / 100).toFixed(2)} /></label><div className="check-grid"><label><input name="featured" type="checkbox" defaultChecked={editingListing.featured} /><span>Destacada</span></label>{isSuperadmin && <label><input name="published" type="checkbox" defaultChecked={editingListing.published} /><span>Visible en catálogo</span></label>}</div><button className="primary-button" type="submit"><Check /> Guardar cambios</button></form></Modal>}

      {publishOpen && <Modal className="form-modal publish-modal" onClose={() => { if (!publishing) setPublishOpen(false); }}><span className="modal-kicker"><Upload /> CONSOLA DE CREADOR</span><h2>Publica tu proyecto</h2><p>El archivo se guarda en este computador y nunca se envía a la nube.</p><form onSubmit={submitListing}><label><span>Tipo de publicación</span><select name="category" value={publishCategory} disabled={publishing} onChange={(event) => setPublishCategory(event.target.value as Category)}><option value="juego">Juego</option><option value="software">Software</option><option value="servicio">Servicio</option></select></label><label><span>Título</span><input name="title" required minLength={3} disabled={publishing} placeholder="Nombre de tu proyecto" /></label><label><span>Descripción</span><textarea name="description" required minLength={12} disabled={publishing} placeholder="Cuéntanos qué lo hace especial" /></label><label><span>Precio (USD)</span><input name="price" type="number" min="0" step="0.01" required disabled={publishing} defaultValue="0.00" /></label>{publishCategory !== "servicio" && <><label className="executable-field"><span>Ejecutable o paquete completo</span><div><FileUp /><input name="executable" type="file" accept=".exe,.msi,.msix,.appx,.zip,.7z,.rar,.tar,.gz,.tgz,.bz2,.xz,.apk,.aab,.appimage,.deb,.rpm,.run,.bin,.dmg,.pkg,.jar" required disabled={publishing} /></div><small>Paquetes y ejecutables para Windows, Android, Linux y macOS · Máximo 2 GB</small></label><div className="build-guidance" role="note"><div><Gamepad2 /><p><strong>Unity</strong><span>Comprime en ZIP toda la carpeta exportada: EXE, carpeta _Data y DLL.</span></p></div><div><Code2 /><p><strong>Godot</strong><span>Sube el EXE si incorpora el PCK; si están separados, súbelos juntos en ZIP.</span></p></div></div></>}<button className="primary-button" type="submit" disabled={publishing}>{publishing ? <><RefreshCw className="spin" /> Subiendo archivo...</> : <>Publicar localmente <ArrowRight /></>}</button></form></Modal>}

      {bookingOpen && <Modal className="form-modal" onClose={() => setBookingOpen(false)}><span className="modal-kicker"><MonitorCog /> SOPORTE TÉCNICO</span><h2>Agenda una revisión</h2><p>La solicitud se guardará en la base local de TAKANA.</p><form onSubmit={submitBooking}><label><span>Nombre</span><input name="name" defaultValue={user?.name || ""} required minLength={2} placeholder="Tu nombre" /></label><label><span>Correo</span><input name="email" defaultValue={user?.email || ""} required type="email" placeholder="tu@correo.com" /></label><label><span>Fecha</span><input name="date" required type="date" /></label><label><span>¿Qué necesita tu equipo?</span><textarea name="notes" placeholder="Describe el problema o servicio" /></label><button className="primary-button" type="submit"><CalendarDays /> Confirmar cita</button></form></Modal>}

      {cartOpen && <div className="drawer-layer" onMouseDown={(event) => { if (event.currentTarget === event.target) setCartOpen(false); }}><aside className="cart-drawer"><button className="modal-close" type="button" onClick={() => setCartOpen(false)}><X /></button><span className="modal-kicker"><ShoppingCart /> TU CARRITO LOCAL</span><h2>{cartCount} producto{cartCount === 1 ? "" : "s"}</h2>{cart.length ? <><div className="cart-list">{cart.map((item) => <article key={item.listingId}><img src={covers[item.coverKey] || covers.orbit} alt="" /><div><strong>{item.title}</strong><small>{categoryCopy[item.category].label} · Cantidad {item.quantity}</small></div><b>{currency(item.priceCents * item.quantity)}</b><button className="cart-remove" type="button" onClick={() => void removeCart(item.listingId)} aria-label={`Quitar ${item.title}`}><X /></button></article>)}</div><div className="cart-total"><span>Total local</span><strong>{currency(cartTotal)}</strong></div><button className="primary-button" type="button" onClick={() => void checkout()}>Confirmar compra <ArrowRight /></button></> : <div className="empty-cart"><ShoppingCart /><p>{authToken ? "Tu carrito está vacío." : "Inicia sesión para usar tu carrito local."}</p></div>}</aside></div>}

      {feedback && <div className="toast"><Check /> {feedback}</div>}
    </div>
  );
}
