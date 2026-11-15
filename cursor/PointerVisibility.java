import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Method;

/** Only changes the existing system mouse icon; never injects keys or motion. */
public final class PointerVisibility {
    public static void main(String[] args) throws Exception {
        Class<?> type = Class.forName("android.hardware.input.InputManager");
        Object manager = type.getMethod("getInstance").invoke(null);
        Method icon = type.getMethod("setPointerIconType", int.class);
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        System.out.println("CURSOR_READY");
        System.out.flush();
        try {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.equals("show")) icon.invoke(manager, 1000);
                else if (line.equals("hide")) icon.invoke(manager, 0);
                else throw new IllegalArgumentException("Unknown visibility command");
            }
        } finally {
            icon.invoke(manager, 1000);
        }
    }
}
