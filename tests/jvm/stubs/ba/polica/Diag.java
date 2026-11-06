package ba.polica;
final class Diag { static final java.util.List<String> lines = new java.util.concurrent.CopyOnWriteArrayList<>(); static void w(android.content.Context c, String what, Throwable e) { lines.add(what); } static void i(android.content.Context c, String what) { lines.add(what); } }
