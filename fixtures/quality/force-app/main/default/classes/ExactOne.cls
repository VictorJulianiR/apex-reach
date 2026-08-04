public class ExactOne {
    public static Integer transform(List<Integer> values) {
        Integer result = 0;
        for (Integer value : values) {
            if (value > 0) {
                result += value * 2;
            } else {
                result -= value;
            }
        }
        return result;
    }
}
